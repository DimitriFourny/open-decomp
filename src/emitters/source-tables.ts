import type { OperationContext } from '../core/index.js';
import { bitWidth, type Instruction, type Value } from '../ir/index.js';
import type { Reconstruction } from '../reconstruction/model.js';
import type { SourceAddress } from '../reconstruction/source-model.js';
import { sourceConstantValues, sourceDataValues } from '../reconstruction/source-data.js';

export interface IndexedDataAccess {
  readonly data: SourceAddress & { readonly object: NonNullable<SourceAddress['object']> };
  readonly index: Value;
  readonly stride: bigint;
  readonly offset: bigint;
  readonly bits: number;
}

/** Match only exact, nonwrapping integer address arithmetic. The declaration is
 * a view of existing storage, never an allocation or a claim of an array bound. */
export function indexedDataAccesses(
  program: Reconstruction,
  context: OperationContext,
): ReadonlyMap<string, IndexedDataAccess> {
  const result = new Map<string, IndexedDataAccess>();
  const data = sourceDataValues(program.expressions, program.source?.addresses ?? [], context);
  const constant = sourceConstantValues(program.expressions, context);
  const narrow = (value: Value): Value => {
    const seen = new Set<string>();
    while (!seen.has(value.id)) {
      seen.add(value.id);
      const expression = program.expressions.get(value.id);
      if (expression?.kind !== 'cast' || expression.op !== 'zero_extend') break;
      value = expression.value;
    }
    return value;
  };
  /** Greatest unsigned value the index can take: its width, lowered by any
   * unsigned-extension chain and constant AND masks (`x & c <= c`). */
  const limits = new Map<string, bigint>();
  const maximum = (value: Value): bigint => {
    const cached = limits.get(value.id);
    if (cached !== undefined) return cached;
    context.checkpoint(1);
    let limit = (1n << BigInt(bitWidth(value.type))) - 1n;
    const expression = program.expressions.get(value.id);
    if (expression?.kind === 'integer' && expression.op === 'and') {
      for (const operand of [expression.left, expression.right]) {
        const bound = constant(operand) ?? maximum(operand);
        if (bound < limit) limit = bound;
      }
    } else if (
      expression?.kind === 'cast' &&
      (expression.op === 'zero_extend' || expression.op === 'bitcast') &&
      expression.value.type.kind === 'integer'
    ) {
      const bound = maximum(expression.value);
      if (bound < limit) limit = bound;
    }
    limits.set(value.id, limit);
    return limit;
  };
  const candidate = (node: Extract<Instruction, { kind: 'load' }>): void => {
    const bits = bitWidth(node.result.type);
    if (
      node.result.type.kind !== 'integer' ||
      program.source?.float_accesses?.has(node.id) ||
      ![8, 16, 32, 64].includes(bits) ||
      node.access.volatile ||
      node.access.endian !== 'little' ||
      node.access.alignment !== 1 ||
      bitWidth(node.address.type) !== 64
    )
      return;
    const address = program.expressions.get(node.address.id);
    if (address?.kind !== 'integer' || address.op !== 'add') return;
    let base = data(address.left),
      index = address.right;
    if (!base?.object) {
      base = data(address.right);
      index = address.left;
    }
    if (
      !base?.object ||
      base.object.kind === 'unknown' ||
      base.address.space !== 'va' ||
      base.object.address.space !== 'va' ||
      base.address.image_id !== base.object.address.image_id ||
      base.object.offset < 0n ||
      base.address.value !== base.object.address.value + base.object.offset
    )
      return;
    let scale = 1n;
    const scaled = program.expressions.get(index.id);
    if (scaled?.kind === 'integer' && (scaled.op === 'mul' || scaled.op === 'shl')) {
      let amount = constant(scaled.right);
      let operand = scaled.left;
      if (amount === undefined && scaled.op === 'mul') {
        amount = constant(scaled.left);
        operand = scaled.right;
      }
      if (amount === undefined || amount < 0n || (scaled.op === 'shl' && amount > 63n)) return;
      scale = scaled.op === 'shl' ? 1n << amount : amount;
      index = operand;
    }
    index = narrow(index);
    const limit = maximum(index);
    const size = BigInt(bits / 8),
      object = base.object;
    if (
      index.type.kind !== 'integer' ||
      scale === 0n ||
      scale % size !== 0n ||
      object.offset % size !== 0n ||
      object.address.value % size !== 0n ||
      object.address.value + object.offset + limit * scale >= 1n << 64n
    )
      return;
    result.set(node.id, {
      data: { ...base, object },
      index,
      stride: scale / size,
      offset: object.offset / size,
      bits,
    });
  };
  for (const block of program.blocks.values())
    for (const node of block.statements) {
      context.checkpoint(1);
      if (
        node.kind === 'load' &&
        program.retained.has(node.id) &&
        !program.source?.locals.has(node.id)
      )
        candidate(node);
    }
  return result;
}
