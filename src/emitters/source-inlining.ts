import type { OperationContext } from '../core/index.js';
import {
  type CastOp,
  expressionOperands,
  type Expression,
  type Instruction,
  type IntegerOp,
  type Value,
} from '../ir/index.js';
import type { BlockRegion } from '../presentation/index.js';
import type { Reconstruction } from '../reconstruction/model.js';
import { controlArms } from './source-control.js';

export type InlineInstruction = Extract<Instruction, { kind: 'assign' | 'load' }>;
export interface InlineSite {
  readonly node: InlineInstruction;
  /** Original statement/control that evaluates this value exactly once (a
   * propagated copy: its first reading statement; every reader prints its source;
   * a repeated operation: its one reader, which evaluates it at every occurrence). */
  readonly anchor: string;
  /** Original anchor of a synthetic pure definition. */
  readonly origin?: string;
  /** A plain copy printed as its source variable at every reader. */
  readonly propagated?: boolean;
  /** A cheap pure operation printed at each of its occurrences in its one reader. */
  readonly repeated?: boolean;
  /** A load of a private local that every reader prints as the local itself:
   * `shared` (the local's next write follows every reader) or `sunk` (that write
   * is printed right after the reader that follows it). */
  readonly local?: 'shared' | 'sunk';
}

export type InlineCall = Extract<Instruction, { kind: 'call' }>;
/** A call whose single result is read by the very next printed statement or
 * the return, `if` or `switch` test: printed once, as that reader's operand, at
 * its original position. */
export interface InlineCallSite {
  readonly node: InlineCall;
  readonly result: Value;
  /** The statement/control that prints the call as an operand. */
  readonly anchor: string;
}
export type InlineStore = Extract<Instruction, { kind: 'store' }>;
export interface InliningPlan {
  readonly sites: Map<string, InlineSite>;
  /** Keyed by the call's result value id. */
  readonly calls: Map<string, InlineCallSite>;
  /** Stores to private locals printed right after the statement `id` instead of
   * at their own position (only for `sunk` load sites). */
  readonly deferred: Map<string, InlineStore[]>;
}

/** Conversions whose result depends on the dynamic FP environment (rounding,
 * flush/denormal modes); bitcasts, negation and absolute value only move bits. */
const ENVIRONMENT_CASTS: Partial<Record<CastOp, true>> = {
  signed_to_float: true,
  unsigned_to_float: true,
  float_to_signed: true,
  float_to_unsigned: true,
  float_convert: true,
};

/** Binary operations cheap enough to repeat at their reader (with a constant operand). */
const REPEATABLE_OPERATIONS: Partial<Record<IntegerOp, true>> = {
  add: true,
  sub: true,
  and: true,
  or: true,
  xor: true,
  shl: true,
  lshr: true,
  ashr: true,
};
const REPEATABLE_CASTS: Partial<Record<CastOp, true>> = {
  truncate: true,
  zero_extend: true,
  sign_extend: true,
  bitcast: true,
};

function environmental(expression: Expression): boolean {
  return (
    expression.kind === 'float' ||
    expression.kind === 'float_compare' ||
    (expression.kind === 'float_unary' && expression.op === 'sqrt') ||
    (expression.kind === 'cast' && ENVIRONMENT_CASTS[expression.op] === true)
  );
}

/** Single-use pure integer expressions may be delayed to their dominated SSA
 * use: they read immutable values, not memory. Pure IEEE scalar expressions
 * (arithmetic, compares, conversions) additionally read the FP environment, so
 * no call, unknown effect or register write may lie on any path from their
 * definition to that use (their recorded FP-environment requirement already
 * excludes contraction). Plain copies of a variable with the same presented
 * type are propagated to every reader. Loads additionally require an
 * unconditional same-block use and an unbroken effect path: every intervening
 * load must belong to their nested address/data dependency chain or read/write
 * a private local. Independent potentially faulting loads therefore never
 * become unsequenced C operands. Blocks in `omitted` are not printed (hidden
 * FP-environment guard failures); their reads are no uses. */
export function planSourceInlining(
  program: Reconstruction,
  context: OperationContext,
  preserve: (value: Value) => boolean,
  alternateIndex: (node: Instruction) => readonly Value[] | undefined,
  /** The variable a multi-use pure definition merely re-presents, if any. */
  plainCopy: (destination: Value, expression: Expression) => Value | undefined = () => undefined,
  omitted: ReadonlySet<string> = new Set(),
  /** Presentation-level admission of a call (its printed result type must be the result variable's). */
  admitCall: (node: InlineCall, result: Value) => boolean = () => false,
): InliningPlan {
  type Use = {
    block: string;
    anchor: string;
    position: number;
    conditional: boolean;
    transfer: boolean;
    alternative?: boolean;
    /** The edge copy a transfer use reads in. */
    copy?: object;
  };
  /** The use of `operand` inside `expression`, evaluated at `at`. */
  const operandAt = (expression: Expression, operand: Value, at: Use): Use =>
    expression.kind === 'select' && operand.id !== expression.condition.id
      ? { ...at, conditional: true }
      : at;
  type Candidate = {
    block: BlockRegion;
    position: number;
    node: InlineInstruction;
    origin?: string;
  };
  const uses = new Map<
    string,
    {
      count: number;
      first: Use;
      /** Every recorded use in program order (bounded by the traversal work cap). */
      all: Use[];
      anchors: Map<string, { original: number; alternative: number }>;
    }
  >();
  const anchors = new Map<string, InlineInstruction>();
  const candidates: Candidate[] = [];
  let work = 0,
    complete = true;
  const use = (value: Value, at: Use, depth = 0): void => {
    context.checkpoint(1);
    if (++work > 65536 || depth > 128) {
      complete = false;
      return;
    }
    const stack = program.source?.stack;
    if (program.source?.stack_addresses.has(value.id)) {
      if (stack?.kind === 'entry') use(stack.base, at, depth + 1);
      return;
    }
    const expression = program.inline.has(value.id) ? program.expressions.get(value.id) : undefined;
    if (expression) {
      for (const operand of expressionOperands(expression)) {
        use(operand, operandAt(expression, operand, at), depth + 1);
        if (!complete) return;
      }
      return;
    }
    const previous = uses.get(value.id);
    // Count the maximum occurrence multiplicity of explicit-address and
    // symbolic-index spellings, not their sum. Repeated leaves within either
    // spelling still count separately and cannot duplicate an inlined load.
    if (previous) {
      const count = previous.anchors.get(at.anchor) ?? { original: 0, alternative: 0 };
      const before = Math.max(count.original, count.alternative);
      if (at.alternative) count.alternative++;
      else count.original++;
      previous.count += Math.max(count.original, count.alternative) - before;
      previous.anchors.set(at.anchor, count);
      previous.all.push(at);
    } else
      uses.set(value.id, {
        count: 1,
        first: at,
        all: [at],
        anchors: new Map([
          [at.anchor, { original: at.alternative ? 0 : 1, alternative: at.alternative ? 1 : 0 }],
        ]),
      });
  };
  for (const block of program.blocks.values()) {
    if (omitted.has(block.id)) continue;
    const definitions = (anchor: string, position: number): void => {
      for (const definition of program.source?.definitions?.get(anchor) ?? []) {
        const node: InlineInstruction = {
          kind: 'assign',
          id: definition.result.id,
          provenance: block.provenance,
          result: definition.result,
          expression: definition.expression,
        };
        anchors.set(node.id, node);
        candidates.push({ block, position, node, origin: anchor });
        const at: Use = {
          block: block.id,
          anchor: node.id,
          position,
          conditional: false,
          transfer: false,
        };
        for (const value of expressionOperands(definition.expression))
          use(value, operandAt(definition.expression, value, at));
      }
    };
    definitions(block.id, -1);
    for (let position = 0; position < block.statements.length; position++) {
      const node = block.statements[position]!;
      const at: Use = {
        block: block.id,
        anchor: node.id,
        position,
        conditional: false,
        transfer: false,
      };
      if (program.retained.has(node.id)) {
        if (node.kind === 'assign' || node.kind === 'load') {
          anchors.set(node.id, node);
          candidates.push({ block, position, node });
        }
        if (node.kind === 'assign') {
          const expression = program.expressions.get(node.result.id) ?? node.expression;
          for (const value of expressionOperands(expression))
            use(value, operandAt(expression, value, at));
        } else if (node.kind === 'load' || node.kind === 'store') {
          if (!program.source?.locals.has(node.id)) use(node.address, at);
          if (node.kind === 'store') use(node.value, at);
          for (const index of alternateIndex(node) ?? []) use(index, { ...at, alternative: true });
        } else if (node.kind === 'write_register') use(node.value, at);
        else if (node.kind === 'call') {
          const projection = program.calls.get(node.id);
          for (const value of projection?.arguments ?? node.arguments) use(value, at);
          for (const binding of projection?.inputs ?? node.register_inputs) use(binding.value, at);
          if (node.target.kind === 'indirect') use(node.target.value, at);
        }
        if ('register_inputs' in node)
          for (const binding of program.physical_inputs.get(node.id) ?? node.register_inputs)
            use(binding.value, at);
      }
      definitions(node.id, position);
    }
    const control = block.control;
    const at: Use = {
      block: block.id,
      anchor: control.id,
      position: block.statements.length,
      conditional: false,
      transfer: false,
    };
    definitions(control.id, at.position);
    if (control.kind === 'if') use(control.condition, at);
    else if (control.kind === 'switch') use(control.value, at);
    else if (control.kind === 'indirect') use(control.target, at);
    if (control.kind === 'return') {
      const projection = program.returns.get(control.id);
      for (const value of projection?.results ?? control.values) use(value, at);
      for (const binding of projection?.outputs ?? block.register_exit) use(binding.value, at);
    }
    for (const binding of program.physical_exits.get(control.id) ?? []) use(binding.value, at);
    const tail = program.tails.get(control.id);
    // A target-value tail prints only its target and observed argument prefix.
    if (!['return', 'jump', 'if'].includes(control.kind) && tail?.target !== null)
      for (const binding of block.register_exit) use(binding.value, at);
    for (const value of tail?.boundary.arguments ?? []) use(value, at);
    const transfers =
      control.kind === 'jump'
        ? [control.transfer]
        : controlArms(control).map((arm) => arm.transfer);
    for (const transfer of transfers)
      for (const copy of program.transfers.get(transfer) ?? [])
        use(copy.source, { ...at, transfer: true, conditional: control.kind !== 'jump', copy });
    if (!complete) return { sites: new Map(), calls: new Map(), deferred: new Map() };
  }
  const result = new Map<string, InlineSite>();
  const scalar = (value: Value): boolean =>
    value.type.kind === 'integer' || value.type.kind === 'float';
  /** Whether expanding `value` evaluates an FP-environment-dependent operation;
   * null when some printed leaf is not an integer/IEEE scalar. */
  const scan = (value: Value, depth = 0): boolean | null => {
    context.checkpoint(1);
    if (!scalar(value) || depth > 128) return null;
    const expression = program.inline.has(value.id) ? program.expressions.get(value.id) : undefined;
    if (!expression) return false;
    let environment = environmental(expression);
    for (const operand of expressionOperands(expression)) {
      const nested = scan(operand, depth + 1);
      if (nested === null) return null;
      environment ||= nested;
    }
    return environment;
  };
  /** Propagated multi-use copies (to their source): never a consumer of another expansion. */
  const shared = new Map<string, Value>();
  const sensitive: Candidate[] = [];
  /** Multi-use integer definitions that may repeat at their one reader (see below). */
  const repeatable: Candidate[] = [];
  for (const candidate of candidates) {
    const { node, origin } = candidate;
    const expression = program.expressions.get(node.result.id);
    const row = uses.get(node.result.id);
    if (
      node.kind !== 'assign' ||
      !expression ||
      !row ||
      !scalar(node.result) ||
      preserve(node.result) ||
      program.inline.has(node.result.id)
    )
      continue;
    let environment: boolean | null = environmental(expression);
    for (const operand of expressionOperands(expression)) {
      const nested = scan(operand);
      environment = nested === null ? null : environment || nested;
      if (environment === null) break;
    }
    if (environment === null) continue;
    if (row.count !== 1) {
      // A plain copy of a printed variable: each reader prints the variable.
      let source = plainCopy(node.result, expression);
      // Through inline identity copies, to the printed variable they re-present.
      for (let depth = 0; source && program.inline.has(source.id) && depth < 8; depth++) {
        const inner = program.expressions.get(source.id);
        source = inner && plainCopy(source, inner);
      }
      if (
        !source ||
        program.inline.has(source.id) ||
        program.source?.stack_addresses.has(source.id)
      ) {
        if (!environment && node.result.type.kind === 'integer') repeatable.push(candidate);
        continue;
      }
      shared.set(node.result.id, source);
    }
    if (environment) sensitive.push(candidate);
    result.set(node.result.id, {
      node,
      anchor: row.first.anchor,
      ...(origin ? { origin } : {}),
    });
  }
  for (const [id, source] of shared) {
    if (!result.has(source.id)) continue;
    result.delete(id);
    shared.delete(id);
  }
  /** The final reading statement/control of a value first read at `first`, through
   * nested inlined definitions; null when they cycle or nest too deeply. */
  const resolve = (first: Use): { at: Use; nested: Set<string> } | null => {
    let at = first;
    const nested = new Set<string>();
    for (let depth = 0; depth < 128; depth++) {
      const consumer = anchors.get(at.anchor);
      if (!consumer || !result.has(consumer.result.id)) return { at, nested };
      if (nested.has(consumer.id) || shared.has(consumer.result.id)) return null;
      nested.add(consumer.id);
      const next = uses.get(consumer.result.id)!.first;
      at = { ...next, conditional: at.conditional || next.conditional };
    }
    return null;
  };
  const destination = (node: InlineInstruction) => resolve(uses.get(node.result.id)!.first);
  // FP-environment readers: no call, unknown effect or register write on any
  // path from the definition to its (final) use that does not re-execute it.
  const writes = (node: Instruction): boolean =>
    node.kind === 'call' || node.kind === 'unknown_effect' || node.kind === 'write_register';
  const successors = (block: BlockRegion): string[] =>
    (block.control.kind === 'jump'
      ? [block.control.transfer]
      : controlArms(block.control).map((arm) => arm.transfer)
    ).map((transfer) => transfer.target);
  let predecessors: Map<string, string[]> | undefined;
  let walked = 0;
  const reach = (
    start: readonly string[],
    next: (id: string) => readonly string[],
    stop: string,
  ) => {
    const seen = new Set<string>();
    const pending = [...start];
    while (pending.length) {
      context.checkpoint(1);
      if (++walked > 65536) return null;
      const id = pending.pop()!;
      if (id === stop || seen.has(id) || !program.blocks.has(id)) continue;
      seen.add(id);
      pending.push(...next(id));
    }
    return seen;
  };
  const quiet = (from: BlockRegion, position: number, at: Use): boolean => {
    const target = program.blocks.get(at.block);
    if (!target) return false;
    const clean = (block: BlockRegion, start: number, end: number): boolean =>
      block.statements.slice(Math.max(start, 0), end).every((node) => !writes(node));
    if (from.id === target.id)
      return at.position > position && clean(from, position + 1, at.position);
    if (!predecessors) {
      predecessors = new Map();
      for (const block of program.blocks.values())
        for (const successor of successors(block))
          predecessors.set(successor, [...(predecessors.get(successor) ?? []), block.id]);
    }
    const forward = reach(successors(from), (id) => successors(program.blocks.get(id)!), from.id);
    const backward = reach([target.id], (id) => predecessors!.get(id) ?? [], from.id);
    if (!forward || !backward || !forward.has(target.id)) return false;
    if (!clean(from, position + 1, from.statements.length)) return false;
    for (const id of forward) {
      if (!backward.has(id)) continue;
      const block = program.blocks.get(id)!;
      const again = id === target.id && successors(block).some((next) => backward.has(next));
      if (!clean(block, 0, id === target.id && !again ? at.position : block.statements.length))
        return false;
    }
    return true;
  };
  for (const { node, block, position } of sensitive) {
    const target = destination(node);
    if (!target || !quiet(block, position, target.at)) result.delete(node.result.id);
  }
  for (let index = candidates.length - 1; index >= 0; index--) {
    const { block, position, node } = candidates[index]!;
    if (
      node.kind !== 'load' ||
      node.result.type.kind !== 'integer' ||
      preserve(node.result) ||
      program.inline.has(node.result.id) ||
      uses.get(node.result.id)?.count !== 1 ||
      !program.source ||
      node.access.volatile ||
      ![8, 16, 32, 64].includes(node.result.type.bits)
    )
      continue;
    const target = destination(node);
    if (!target) continue;
    const { at, nested } = target;
    const local = program.source.locals.get(node.id);
    if (at.block !== block.id || at.position <= position || at.conditional || at.transfer) continue;
    let ordered = true;
    for (let p = position + 1; p < at.position; p++) {
      const between = block.statements[p]!;
      // A private local is no memory: its reads and writes cannot fault or alias.
      const privateLocal =
        (between.kind === 'load' || between.kind === 'store') &&
        program.source.locals.has(between.id);
      if (
        (program.retained.has(between.id) &&
          (local
            ? between.kind === 'store' && program.source.locals.get(between.id)?.id === local.id
            : between.kind !== 'assign' && !nested.has(between.id) && !privateLocal)) ||
        program.source?.definitions
          ?.get(between.id)
          ?.some((definition) => !result.has(definition.result.id))
      ) {
        ordered = false;
        break;
      }
    }
    if (ordered) result.set(node.result.id, { node, anchor: at.anchor });
  }
  // The idiom `t = L; L = f(t); ...; reader(t)` (post-increment) and its
  // reversed order: a load of a private local read by exactly the next write to
  // that local (a pure function of the loaded value alone) and one other
  // statement of the same block. Both read the local itself: before the write,
  // or, when the other reader follows the write, with the write printed right
  // after that reader. Nothing between touches the local, the write has no
  // effect beyond the private local, and no variable read moves.
  const deferred = new Map<string, InlineStore[]>();
  const stored = new Set<string>(),
    readers = new Set<string>(),
    anchorOverride = new Map<string, string>();
  if (program.source)
    for (const { block, position, node } of candidates) {
      context.checkpoint(1);
      const local = program.source.locals.get(node.id)?.id,
        row = uses.get(node.result.id);
      if (
        node.kind !== 'load' ||
        !local ||
        !row ||
        row.count < 2 ||
        node.access.volatile ||
        node.result.type.kind !== 'integer' ||
        ![8, 16, 32, 64].includes(node.result.type.bits) ||
        preserve(node.result) ||
        program.inline.has(node.result.id) ||
        result.has(node.result.id)
      )
        continue;
      const finals = new Map<string, Use>();
      let usable = true;
      for (const use of row.all) {
        const target = resolve(use);
        if (
          !target ||
          target.at.block !== block.id ||
          target.at.position <= position ||
          target.at.position >= block.statements.length ||
          target.at.conditional ||
          target.at.transfer ||
          target.at.alternative ||
          block.statements[target.at.position]!.id !== target.at.anchor
        ) {
          usable = false;
          break;
        }
        finals.set(target.at.anchor, target.at);
      }
      if (!usable || finals.size !== 2) continue;
      const touches = (between: Instruction): boolean =>
        (between.kind === 'load' || between.kind === 'store') &&
        program.source!.locals.get(between.id)?.id === local;
      const ordered = [...finals.values()].sort((a, b) => a.position - b.position);
      /** Pure integer function of this load alone. */
      const pure = (value: Value, depth = 0): boolean => {
        if (value.id === node.result.id) return true;
        const expression = program.expressions.get(value.id);
        if (!expression || depth > 16) return false;
        if (expression.kind === 'constant') return true;
        const site = result.get(value.id);
        return (
          (program.inline.has(value.id) || site?.node.kind === 'assign') &&
          !environmental(expression) &&
          expressionOperands(expression).every((operand) => pure(operand, depth + 1))
        );
      };
      const writer = ordered.find((at) => {
        const statement = block.statements[at.position]!;
        return (
          statement.kind === 'store' &&
          program.retained.has(statement.id) &&
          !statement.access.volatile &&
          touches(statement) &&
          pure(statement.value) &&
          (program.physical_inputs.get(statement.id) ?? statement.register_inputs).length === 0
        );
      });
      if (!writer) continue;
      const store = block.statements[writer.position]!;
      if (store.kind !== 'store') continue;
      const other = ordered.find((at) => at !== writer)!;
      const reader = block.statements[other.position]!;
      const last = Math.max(writer.position, other.position);
      let clear = !touches(reader);
      for (let p = position + 1; clear && p <= last; p++) {
        const between = block.statements[p]!;
        if (
          (p !== writer.position && touches(between)) ||
          program.source.definitions
            ?.get(between.id)
            ?.some((definition) => !result.has(definition.result.id))
        )
          clear = false;
      }
      if (!clear) continue;
      const sunk = other.position > writer.position;
      if (sunk) {
        if (
          !program.retained.has(reader.id) ||
          stored.has(reader.id) ||
          readers.has(store.id) ||
          !(
            reader.kind === 'store' ||
            ((reader.kind === 'assign' || reader.kind === 'load') && !result.has(reader.result.id))
          )
        )
          continue;
        stored.add(store.id);
        readers.add(reader.id);
        deferred.set(reader.id, [...(deferred.get(reader.id) ?? []), store]);
      }
      result.set(node.result.id, { node, anchor: other.anchor, local: sunk ? 'sunk' : 'shared' });
      anchorOverride.set(node.result.id, other.anchor);
    }
  // One cheap integer operation on a printed variable (with a constant: `x >> 1`,
  // `x & 0xff`; or a conversion `(uint8_t)x`) read by exactly one statement, test
  // or edge copy, at most four times (`y = c ? (x >> 1) ^ k : x >> 1`), repeats
  // there instead of naming a temporary: it is pure and its operands are read
  // where the reader reads them. An edge copy reads it only through one consumer
  // statement, so every occurrence lies in that one copy.
  const repeated = new Set<string>();
  const constant = (value: Value): boolean =>
    program.inline.has(value.id) && program.expressions.get(value.id)?.kind === 'constant';
  const leaf = (value: Value): boolean =>
    constant(value) ||
    (!program.inline.has(value.id) &&
      !result.has(value.id) &&
      !program.source?.stack_addresses.has(value.id));
  for (const { node, origin } of repeatable) {
    context.checkpoint(1);
    const expression = program.expressions.get(node.result.id)!,
      row = uses.get(node.result.id)!;
    const cheap =
      expression.kind === 'integer'
        ? REPEATABLE_OPERATIONS[expression.op] === true &&
          leaf(expression.left) &&
          leaf(expression.right) &&
          constant(expression.left) !== constant(expression.right)
        : expression.kind === 'integer_unary'
          ? (expression.op === 'not' || expression.op === 'neg') && leaf(expression.value)
          : expression.kind === 'cast'
            ? REPEATABLE_CASTS[expression.op] === true && leaf(expression.value)
            : expression.kind === 'extract' && leaf(expression.value);
    // Every direct use lies in one edge copy, or none does.
    const copies = new Set(row.all.map((use) => use.copy));
    if (!cheap || row.count > 4 || row.all.length > 4 || copies.size !== 1) continue;
    let anchor: string | undefined,
      copied = false;
    for (const use of row.all) {
      const target = use.alternative ? null : resolve(use);
      if (!target || (anchor !== undefined && target.at.anchor !== anchor)) {
        anchor = undefined;
        break;
      }
      anchor = target.at.anchor;
      copied ||= target.at.transfer;
    }
    // An edge copy reached through consumers: all direct uses lie in one consumer.
    if (anchor === undefined || (copied && copies.has(undefined) && row.anchors.size !== 1))
      continue;
    result.set(node.result.id, { node, anchor, repeated: true, ...(origin ? { origin } : {}) });
    repeated.add(node.id);
  }
  // Pure definitions were selected before loads, independent of block layout.
  // Resolve all mapping anchors to the final consuming statement/control.
  for (const [id, site] of result) {
    const target = destination(site.node);
    if (!target) return { sites: new Map(), calls: new Map(), deferred: new Map() };
    result.set(id, {
      ...site,
      anchor: anchorOverride.get(id) ?? target.at.anchor,
      ...(shared.has(id) ? { propagated: true } : {}),
    });
  }
  const calls = new Map<string, InlineCallSite>();
  const environment = new Set(sensitive.map(({ node }) => node.result.id));
  const printsStatement = (node: Instruction): boolean =>
    program.retained.has(node.id) && !('result' in node && result.has(node.result.id));
  const printsDefinition = (anchor: string): boolean =>
    program.source?.definitions?.get(anchor)?.some((item) => !result.has(item.result.id)) ?? false;
  // Blocks entered by exactly one control transfer (and not as the function entry).
  const entries = new Map<string, number>();
  for (const block of program.blocks.values())
    for (const transfer of block.control.kind === 'jump'
      ? [block.control.transfer]
      : controlArms(block.control).map((arm) => arm.transfer))
      entries.set(transfer.target, (entries.get(transfer.target) ?? 0) + 1);
  entries.set(program.function.entry, (entries.get(program.function.entry) ?? 0) + 1);
  for (const block of program.blocks.values()) {
    if (omitted.has(block.id)) continue;
    for (let position = 0; position < block.statements.length; position++) {
      context.checkpoint(1);
      const node = block.statements[position]!;
      const projection = node.kind === 'call' ? program.calls.get(node.id) : undefined;
      if (node.kind !== 'call' || !projection || !program.retained.has(node.id)) continue;
      const live = projection.results.filter((value) => program.live.has(value.id));
      const [value] = live;
      const row = value && uses.get(value.id);
      if (
        live.length !== 1 ||
        !value ||
        !row ||
        row.count !== 1 ||
        !scalar(value) ||
        preserve(value) ||
        program.inline.has(value.id) ||
        !row.first ||
        row.first.transfer ||
        row.first.alternative ||
        row.first.conditional ||
        // Live clobbers that are not results print as separate statements.
        projection.outputs.some(
          (binding) =>
            program.live.has(binding.value.id) &&
            !projection.results.some((returned) => returned.id === binding.value.id) &&
            !program.expressions.has(binding.value.id),
        )
      )
        continue;
      const target = resolve(row.first);
      const reader = target && program.blocks.get(target.at.block);
      if (
        !target ||
        !reader ||
        target.at.conditional ||
        target.at.transfer ||
        omitted.has(reader.id) ||
        [...target.nested].some((id) => repeated.has(id))
      )
        continue;
      const { at } = target;
      const consumer = reader.statements[at.position];
      // Nothing may print between the call and its reader, which may lead the
      // single-entry blocks that follow the call's through plain jumps; the
      // reader must print the call exactly once as an operand evaluated after it.
      let adjacent = !printsDefinition(node.id),
        cursor = block,
        from = position + 1;
      for (let hops = 0; adjacent; hops++) {
        const end = cursor.id === reader.id ? at.position : cursor.statements.length;
        if (end < from) adjacent = false;
        for (let between = from; adjacent && between < end; between++) {
          const other = cursor.statements[between]!;
          adjacent = !printsStatement(other) && !printsDefinition(other.id);
        }
        if (cursor.id === reader.id) break;
        const control = cursor.control;
        const next =
          control.kind === 'jump' && !program.transfers.get(control.transfer)?.length
            ? program.blocks.get(control.transfer.target)
            : undefined;
        adjacent =
          adjacent &&
          !!next &&
          hops < 8 &&
          !omitted.has(next.id) &&
          entries.get(next.id) === 1 &&
          !printsDefinition(control.id) &&
          !printsDefinition(next.id);
        if (next) cursor = next;
        from = 0;
      }
      if (!adjacent) continue;
      if (consumer) {
        if (
          !printsStatement(consumer) ||
          consumer.id !== at.anchor ||
          (consumer.kind !== 'assign' && consumer.kind !== 'store' && consumer.kind !== 'call') ||
          (consumer.kind === 'call' &&
            consumer.target.kind === 'indirect' &&
            consumer.target.value.id === value.id)
        )
          continue;
      } else if (
        at.position !== reader.statements.length ||
        (reader.control.kind !== 'return' &&
          reader.control.kind !== 'if' &&
          reader.control.kind !== 'switch') ||
        reader.control.id !== at.anchor ||
        printsDefinition(reader.control.id)
      )
        continue;
      // C leaves operand order open: no other memory read, call or environment
      // read may be an unsequenced operand of the same reader. A load whose
      // address reads the call's result (`strerror(*__error())`) is sequenced
      // after the call.
      const reads = (operand: Value, depth: number): boolean => {
        context.checkpoint(1);
        if (operand.id === value.id) return true;
        const site = result.get(operand.id);
        if (depth > 32) return false;
        if (site?.node.kind === 'load') return reads(site.node.address, depth + 1);
        const expression =
          site || program.inline.has(operand.id) ? program.expressions.get(operand.id) : undefined;
        return (
          !!expression && expressionOperands(expression).some((nested) => reads(nested, depth + 1))
        );
      };
      let ordered = true;
      for (const [id, site] of result)
        if (
          site.anchor === at.anchor &&
          (environment.has(id) || (site.node.kind === 'load' && !reads(site.node.address, 0)))
        ) {
          ordered = false;
          break;
        }
      if (ordered && admitCall(node, value))
        calls.set(value.id, { node, result: value, anchor: at.anchor });
    }
  }
  return { sites: result, calls, deferred };
}
