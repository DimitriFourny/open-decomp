import assert from 'node:assert/strict';
import { createOperationContext } from '../../src/core/index.js';
import { assertValidIR, evaluateIR, successors } from '../../src/ir/index.js';
import type {
  BasicBlock,
  Edge,
  EvaluationOptions,
  SSAForm,
  Terminator,
} from '../../src/ir/index.js';
import { structureControlFlow } from '../../src/presentation/index.js';
import type {
  BlockRegion,
  ControlArm,
  ParallelTransfer,
  Region,
  StructuredFunction,
} from '../../src/presentation/index.js';

export function regions(root: Region): Region[] {
  const result: Region[] = [],
    pending = [root];
  while (pending.length) {
    const region = pending.pop()!;
    result.push(region);
    if (region.kind === 'sequence') pending.push(...region.regions);
    else if (region.kind === 'loop') pending.push(region.body);
    else {
      const control = region.control;
      const arms =
        control.kind === 'if'
          ? [control.when_true, control.when_false]
          : control.kind === 'switch'
            ? [...control.cases.map((item) => item.arm), control.otherwise]
            : [];
      for (const arm of arms) if (arm.body) pending.push(arm.body);
    }
  }
  return result;
}

/** Reconstructs semantics from region statements, controls and copy destinations.
 * No access to the input CFG: deleting/moving effects or changing arm transfers
 * changes this program. Loop/sequence nesting is also checked against transfers.
 */
export function lower(presentation: StructuredFunction): SSAForm {
  const all = regions(presentation.body),
    labels = new Map<string, BlockRegion>();
  for (const region of all)
    if (region.kind === 'block') {
      assert.ok(!labels.has(region.id), 'each label is owned exactly once');
      labels.set(region.id, region);
    }
  const first = (region: Region): string =>
    region.kind === 'block'
      ? region.id
      : region.kind === 'loop'
        ? region.header
        : first(region.regions[0]!);
  const edge = (transfer: ParallelTransfer): Edge => {
    const target = labels.get(transfer.target)!;
    assert.ok(target, 'transfer has a real target');
    assert.equal(transfer.effect.destination.id, target.effect_parameter.id);
    const copies = new Map(transfer.copies.map((copy) => [copy.destination.id, copy.source]));
    assert.equal(copies.size, target.parameters.length);
    const args = target.parameters.map((parameter) => {
      const source = copies.get(parameter.id);
      assert.ok(source);
      return source;
    });
    return { target: target.id, arguments: args, effect: transfer.effect.source };
  };
  const armEdge = (arm: ControlArm): Edge => {
    if (arm.body) {
      assert.equal(arm.transfer.mode, 'next');
      assert.equal(arm.transfer.target, first(arm.body));
    }
    return edge(arm.transfer);
  };
  for (const region of all)
    if (region.kind === 'loop') {
      assert.equal(first(region.body), region.header);
      const members = new Set(
        regions(region.body)
          .filter((item): item is BlockRegion => item.kind === 'block')
          .map((item) => item.id),
      );
      for (const member of regions(region.body))
        if (member.kind === 'block') {
          const c = member.control;
          const transfers =
            c.kind === 'jump'
              ? [c.transfer]
              : c.kind === 'if'
                ? [c.when_true.transfer, c.when_false.transfer]
                : c.kind === 'switch'
                  ? [...c.cases.map((item) => item.arm.transfer), c.otherwise.transfer]
                  : [];
          for (const transfer of transfers) {
            if (transfer.loop !== region.header) continue;
            if (transfer.mode === 'continue') assert.equal(transfer.target, region.header);
            else {
              assert.equal(transfer.mode, 'break');
              assert.ok(!members.has(transfer.target));
            }
          }
        }
    }
  const blocks: BasicBlock[] = [];
  for (const region of labels.values()) {
    const c = region.control;
    const origin = { id: c.id, provenance: c.provenance, effect: c.effect };
    let terminator: Terminator;
    switch (c.kind) {
      case 'jump':
        terminator = { ...origin, kind: 'jump', edge: edge(c.transfer) };
        break;
      case 'if':
        terminator = {
          ...origin,
          kind: 'branch',
          condition: c.condition,
          when_true: armEdge(c.when_true),
          when_false: armEdge(c.when_false),
        };
        break;
      case 'switch':
        terminator = {
          ...origin,
          kind: 'switch',
          value: c.value,
          cases: c.cases.map((item) => ({ bits: item.bits, edge: armEdge(item.arm) })),
          otherwise: armEdge(c.otherwise),
        };
        break;
      default:
        terminator = c;
    }
    blocks.push({
      id: region.id,
      provenance: region.provenance,
      parameters: region.parameters,
      effect_parameter: region.effect_parameter,
      instructions: region.statements,
      terminator,
    });
  }
  const ir: SSAForm = {
    form: 'ssa',
    id: presentation.id,
    provenance: presentation.provenance,
    entry: presentation.entry,
    returns: presentation.returns,
    blocks,
    register_states: [...labels.values()].map((region) => ({
      block: region.id,
      entry: region.register_entry,
      exit: region.register_exit,
    })),
  };
  assertValidIR(ir);
  return ir;
}

export function equivalent(
  input: SSAForm,
  inputs: readonly EvaluationOptions[] = [{}],
): StructuredFunction {
  const result = structureControlFlow(input, createOperationContext());
  assert.equal(result.state, 'complete');
  assert.ok(result.value);
  const output = lower(result.value);
  for (const options of inputs)
    assert.deepEqual(evaluateIR(output, options), evaluateIR(input, options));
  assert.deepEqual(
    new Set(result.value.coverage.map((item) => item.block_id)),
    new Set(input.blocks.map((block) => block.id)),
  );
  for (const block of input.blocks) {
    const actual = output.blocks.find((item) => item.id === block.id)!;
    assert.deepEqual(actual.provenance, block.provenance);
    assert.deepEqual(
      actual.instructions.map((node) => [node.id, node.provenance]),
      block.instructions.map((node) => [node.id, node.provenance]),
    );
    assert.equal(actual.terminator.id, block.terminator.id);
    assert.deepEqual(actual.terminator.provenance, block.terminator.provenance);
    // Every CFG edge is represented exactly once, in order, with its own copies and effect.
    const shape = (terminator: Terminator) =>
      successors(terminator).map((edge) => [
        edge.target,
        edge.arguments.map((value) => value.id),
        edge.effect.id,
      ]);
    assert.deepEqual(shape(actual.terminator), shape(block.terminator));
  }
  return result.value;
}
