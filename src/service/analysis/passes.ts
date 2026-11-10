import { OperationError, type Diagnostic, type OperationContext } from '../../core/index.js';
import { assertValidIR, type FunctionIR } from '../../ir/index.js';

export function requirePass(
  state: 'complete' | 'partial',
  diagnostics: readonly Diagnostic[],
  context: OperationContext,
): void {
  context.checkpoint(0);
  const failure = diagnostics.find(
    (item) => item.code === 'cancelled' || item.code === 'resource_limit',
  );
  if (failure) throw new OperationError(failure);
  if (state === 'partial')
    throw new OperationError({
      code: 'unavailable_semantics',
      severity: 'error',
      message: 'Analysis pass did not produce a complete valid representation',
      evidence_ids: [],
    });
}

export function boundIR(ir: FunctionIR, context: OperationContext): number {
  let nodes = 0;
  for (const block of ir.blocks) {
    context.checkpoint(1 + block.instructions.length + block.parameters.length);
    nodes += 3 + block.parameters.length + block.instructions.length;
    if (nodes > context.budget.ir_nodes || ir.blocks.length > context.budget.blocks) {
      const blocks = ir.blocks.length > context.budget.blocks;
      // The exhausted capacity, so a caller that bounded it (a native context specialization
      // under the worklist's remaining capacity) can recognize its own limit.
      throw new OperationError({
        code: 'resource_limit',
        severity: 'error',
        message: 'Lifted/SSA graph exceeds the operation node or block budget',
        evidence_ids: [],
        details: blocks
          ? {
              kind: 'limit',
              resource: 'blocks',
              limit: context.budget.blocks,
              consumed: ir.blocks.length,
            }
          : {
              kind: 'limit',
              resource: 'ir_nodes',
              limit: context.budget.ir_nodes,
              consumed: nodes,
            },
      });
    }
  }
  assertValidIR(ir, (work) => context.checkpoint(work));
  return nodes;
}
