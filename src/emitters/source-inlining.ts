import type { OperationContext } from '../core/index.js';
import { expressionOperands, type Instruction, type Value } from '../ir/index.js';
import type { BlockRegion } from '../presentation/index.js';
import type { Reconstruction } from '../reconstruction/model.js';
import { controlArms } from './source-control.js';

export type InlineInstruction = Extract<Instruction, { kind: 'assign' | 'load' }>;
export interface InlineSite {
  readonly node: InlineInstruction;
  /** Original statement/control that evaluates this value exactly once. */
  readonly anchor: string;
  /** Original anchor of a synthetic pure definition. */
  readonly origin?: string;
}

/** Single-use integer expressions may be delayed to their dominated SSA use:
 * they read immutable values, not memory. Loads additionally require an
 * unconditional same-block use and an unbroken effect path: every intervening
 * load must belong to their nested address/data dependency chain. Independent
 * potentially faulting loads therefore never become unsequenced C operands. */
export function planSourceInlining(
  program: Reconstruction,
  context: OperationContext,
  preserve: (value: Value) => boolean,
  alternateIndex: (node: Instruction) => Value | undefined,
): Map<string, InlineSite> {
  type Use = {
    block: string;
    anchor: string;
    position: number;
    conditional: boolean;
    transfer: boolean;
    alternative?: boolean;
  };
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
        use(
          operand,
          expression.kind === 'select' && operand.id !== expression.condition.id
            ? { ...at, conditional: true }
            : at,
          depth + 1,
        );
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
    } else
      uses.set(value.id, {
        count: 1,
        first: at,
        anchors: new Map([
          [at.anchor, { original: at.alternative ? 0 : 1, alternative: at.alternative ? 1 : 0 }],
        ]),
      });
  };
  for (const block of program.blocks.values()) {
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
          use(
            value,
            definition.expression.kind === 'select' &&
              value.id !== definition.expression.condition.id
              ? { ...at, conditional: true }
              : at,
          );
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
            use(
              value,
              expression.kind === 'select' && value.id !== expression.condition.id
                ? { ...at, conditional: true }
                : at,
            );
        } else if (node.kind === 'load' || node.kind === 'store') {
          if (!program.source?.locals.has(node.id)) use(node.address, at);
          if (node.kind === 'store') use(node.value, at);
          const index = alternateIndex(node);
          if (index) use(index, { ...at, alternative: true });
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
    if (!['return', 'jump', 'if'].includes(control.kind))
      for (const binding of block.register_exit) use(binding.value, at);
    for (const value of program.tails.get(control.id)?.boundary.arguments ?? []) use(value, at);
    const transfers =
      control.kind === 'jump'
        ? [control.transfer]
        : controlArms(control).map((arm) => arm.transfer);
    for (const transfer of transfers)
      for (const copy of program.transfers.get(transfer) ?? [])
        use(copy.source, { ...at, transfer: true, conditional: control.kind !== 'jump' });
    if (!complete) return new Map();
  }
  const result = new Map<string, InlineSite>();
  const eligible = (node: InlineInstruction): boolean =>
    node.result.type.kind === 'integer' &&
    !preserve(node.result) &&
    !program.inline.has(node.result.id) &&
    uses.get(node.result.id)?.count === 1;
  const integerOnly = (value: Value, depth = 0): boolean => {
    context.checkpoint(1);
    if (value.type.kind !== 'integer' || depth > 128) return false;
    const expression = program.inline.has(value.id) ? program.expressions.get(value.id) : undefined;
    return (
      !expression ||
      [...expressionOperands(expression)].every((operand) => integerOnly(operand, depth + 1))
    );
  };
  for (const { node, origin } of candidates) {
    if (node.kind !== 'assign' || !eligible(node) || !program.expressions.has(node.result.id))
      continue;
    if (
      ![...expressionOperands(program.expressions.get(node.result.id)!)].every((value) =>
        integerOnly(value),
      )
    )
      continue;
    result.set(node.result.id, {
      node,
      anchor: uses.get(node.result.id)!.first.anchor,
      ...(origin ? { origin } : {}),
    });
  }
  const destination = (node: InlineInstruction): { at: Use; nested: Set<string> } | null => {
    let at = uses.get(node.result.id)!.first;
    const nested = new Set<string>();
    for (let depth = 0; depth < 128; depth++) {
      const consumer = anchors.get(at.anchor);
      if (!consumer || !result.has(consumer.result.id)) return { at, nested };
      if (nested.has(consumer.id)) return null;
      nested.add(consumer.id);
      const next = uses.get(consumer.result.id)!.first;
      at = { ...next, conditional: at.conditional || next.conditional };
    }
    return null;
  };
  for (let index = candidates.length - 1; index >= 0; index--) {
    const { block, position, node } = candidates[index]!;
    if (
      node.kind !== 'load' ||
      !eligible(node) ||
      !program.source ||
      node.access.volatile ||
      ![8, 16, 32, 64].includes(node.result.type.kind === 'integer' ? node.result.type.bits : 0)
    )
      continue;
    const target = destination(node);
    if (!target) continue;
    const { at, nested } = target;
    if (at.block !== block.id || at.position <= position || at.conditional || at.transfer) continue;
    let ordered = true;
    for (let p = position + 1; p < at.position; p++) {
      const between = block.statements[p]!;
      if (
        (program.retained.has(between.id) &&
          between.kind !== 'assign' &&
          !nested.has(between.id)) ||
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
  // Pure definitions were selected before loads, independent of block layout.
  // Resolve all mapping anchors to the final consuming statement/control.
  for (const [id, site] of result) {
    const target = destination(site.node);
    if (!target) return new Map();
    result.set(id, { ...site, anchor: target.at.anchor });
  }
  return result;
}
