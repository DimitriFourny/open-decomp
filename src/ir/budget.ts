import { OperationError } from '../core/index.js';

export interface IRConstructionLimits {
  readonly max_ir_nodes?: number;
  readonly max_blocks?: number;
  readonly checkpoint?: (work: number) => void;
}

/** Per-representation capacity; work remains cumulative in the operation callback. */
export class IRConstructionBudget {
  #nodes = 0;
  #blocks = 0;
  constructor(readonly limits: IRConstructionLimits = {}) {
    for (const limit of [limits.max_ir_nodes, limits.max_blocks]) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
        throw new RangeError('IR construction limits must be nonnegative safe integers');
    }
  }
  block(parameters: number): void {
    this.limits.checkpoint?.(0);
    const blocks = this.#blocks + 1;
    if (blocks > (this.limits.max_blocks ?? Infinity))
      this.#exceeded('blocks', this.limits.max_blocks!, blocks);
    // Reserve the block, effect parameter and eventual terminator before allocation.
    this.nodes(3 + parameters);
    this.#blocks = blocks;
  }
  nodes(count = 1): void {
    this.limits.checkpoint?.(count);
    const nodes = this.#nodes + count;
    if (nodes > (this.limits.max_ir_nodes ?? Infinity))
      this.#exceeded('ir_nodes', this.limits.max_ir_nodes!, nodes);
    this.#nodes = nodes;
  }
  #exceeded(resource: 'blocks' | 'ir_nodes', limit: number, consumed: number): never {
    throw new OperationError({
      code: 'resource_limit',
      severity: 'error',
      message: 'IR construction exceeds the operation budget',
      evidence_ids: [],
      details: { kind: 'limit', resource, limit, consumed },
    });
  }
}
