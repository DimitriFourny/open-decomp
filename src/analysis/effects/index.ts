import type { EntityId } from '../../core/index.js';
import { expressionOperands, successors } from '../../ir/index.js';
import type { Expression, Instruction, Terminator, Value } from '../../ir/index.js';

/** Shared semantic operand traversal. Register snapshots are uses, boundary outputs are definitions. */
export function instructionOperands(node: Instruction): readonly Value[] {
  switch (node.kind) {
    case 'assign':
      return expressionOperands(node.expression);
    case 'read_register':
    case 'memory_fence':
      return [];
    case 'write_register':
      return [node.value];
    case 'load':
      return [node.address, ...node.register_inputs.map((binding) => binding.value)];
    case 'store':
      return [node.address, node.value, ...node.register_inputs.map((binding) => binding.value)];
    case 'call':
      return [
        ...(node.target.kind === 'indirect' ? [node.target.value] : []),
        ...node.arguments,
        ...node.register_inputs.map((binding) => binding.value),
      ];
    case 'unknown_effect':
      return node.register_inputs.map((binding) => binding.value);
  }
}
export function instructionResults(node: Instruction): readonly Value[] {
  switch (node.kind) {
    case 'assign':
    case 'read_register':
    case 'load':
      return [node.result];
    case 'call':
      return [...node.results, ...node.register_outputs.map((binding) => binding.value)];
    case 'unknown_effect':
      return node.register_outputs.map((binding) => binding.value);
    default:
      return [];
  }
}
export function terminatorOperands(node: Terminator): readonly Value[] {
  const edges = successors(node).flatMap((edge) => edge.arguments);
  switch (node.kind) {
    case 'branch':
      return [node.condition, ...edges];
    case 'switch':
      return [node.value, ...edges];
    case 'return':
      return node.values;
    case 'indirect':
      return [node.target];
    default:
      return edges;
  }
}
export function mapExpression(expression: Expression, map: (value: Value) => Value): Expression {
  switch (expression.kind) {
    case 'constant':
    case 'address':
    case 'indeterminate':
      return expression;
    case 'integer':
    case 'compare':
    case 'float':
    case 'float_compare':
    case 'vector_integer':
    case 'vector_float':
      return { ...expression, left: map(expression.left), right: map(expression.right) };
    case 'integer_unary':
    case 'cast':
    case 'extract':
    case 'float_unary':
      return { ...expression, value: map(expression.value) };
    case 'insert':
      return { ...expression, base: map(expression.base), value: map(expression.value) };
    case 'concat':
      return { ...expression, values: expression.values.map(map) };
    case 'select':
      return {
        ...expression,
        condition: map(expression.condition),
        when_true: map(expression.when_true),
        when_false: map(expression.when_false),
      };
    case 'flag':
      return {
        ...expression,
        left: map(expression.left),
        right: map(expression.right),
        carry: map(expression.carry),
      };
    case 'vector':
      return { ...expression, lanes: expression.lanes.map(map) };
    case 'vector_lane':
      return { ...expression, vector: map(expression.vector) };
    case 'vector_insert':
      return { ...expression, vector: map(expression.vector), value: map(expression.value) };
  }
}
export interface EffectSummary {
  readonly node: EntityId;
  readonly reads_memory: boolean;
  readonly writes_memory: boolean;
  readonly barrier: boolean;
  readonly may_stop: boolean;
}
/** No nonvolatile load is removable: even a dead result may fault. Unknown aliases never forward. */
export function summarizeEffect(node: Instruction): EffectSummary | null {
  if (node.kind === 'assign') return null;
  const call = node.kind === 'call' || node.kind === 'unknown_effect';
  return {
    node: node.id,
    reads_memory: node.kind === 'load' || (call && node.clobbers.memory !== 'none'),
    writes_memory: node.kind === 'store' || (call && node.clobbers.memory === 'unknown_read_write'),
    barrier:
      call || node.kind === 'memory_fence' || node.kind === 'store' ||
      (node.kind === 'load' && node.access.volatile),
    may_stop: call || node.kind === 'load' || node.kind === 'store',
  };
}
