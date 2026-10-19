import {
  entityIdentity,
  type Address,
  type CFGBlock,
  type CFGEdge,
  type DecodedInstruction,
  type OperationContext,
} from '../../core/index.js';

/** Calls deliberately contribute only their continuation to intraprocedural
 * reachability; a direct call to a proven noreturn callee contributes none. */
export function instructionSuccessors(
  instruction: DecodedInstruction,
  noreturn?: Pick<ReadonlyMap<bigint, unknown>, 'has'>,
): readonly Address[] {
  if (instruction.validity !== 'valid') return [];
  const flow = instruction.flow;
  switch (flow.kind) {
    case 'fallthrough':
      return [flow.next];
    case 'call':
      return !flow.indirect && flow.target && noreturn?.has(flow.target.value)
        ? []
        : [flow.fallthrough];
    case 'branch':
      return flow.fallthrough ? [flow.target, flow.fallthrough] : [flow.target];
    case 'indirect_branch':
    case 'trap':
      return flow.fallthrough ? [flow.fallthrough] : [];
    case 'unknown':
      return flow.may_fallthrough &&
        instruction.address.value + BigInt(instruction.size) < 1n << 64n
        ? [{ ...instruction.address, value: instruction.address.value + BigInt(instruction.size) }]
        : [];
    case 'return':
      return [];
  }
}

export interface CFGInput {
  readonly slice_id: string;
  readonly function_id: string;
  readonly entry: Address;
  readonly instructions: readonly DecodedInstruction[];
  readonly function_entries: Pick<ReadonlySet<bigint>, 'has'>;
  readonly evidence: ReadonlyMap<string, readonly string[]>;
  /** Proven jump-table targets by indirect branch address; they replace its unknown edge. */
  readonly jump_tables?: ReadonlyMap<bigint, readonly Address[]>;
  /** Direct call targets proven not to return, with the evidence of that proof. */
  readonly noreturn_calls?: ReadonlyMap<bigint, readonly string[]>;
}

/** Build maximal basic blocks from reachable instructions, not a sweep of an enclosing range.
 * Targets absent from this function retain their addresses with null block IDs. Tail-call edges
 * are exits (never successors); calls themselves live in discovery's ReferenceRecord index.
 * Throws OperationError through the supplied context on work/deadline/cancellation limits.
 */
export function buildCFG(input: CFGInput, context: OperationContext): readonly CFGBlock[] {
  const sorted = [...input.instructions].sort((a, b) =>
    a.address.value < b.address.value ? -1 : a.address.value > b.address.value ? 1 : 0,
  );
  const tableTargets = (instruction: DecodedInstruction): readonly Address[] | undefined =>
    instruction.validity === 'valid' && instruction.flow.kind === 'indirect_branch'
      ? input.jump_tables?.get(instruction.address.value)
      : undefined;
  const leaders = new Set<bigint>([input.entry.value]);
  const incoming = new Map<bigint, number>();
  for (const instruction of sorted) {
    context.checkpoint(1);
    for (const successor of tableTargets(instruction) ??
      instructionSuccessors(instruction, input.noreturn_calls)) {
      incoming.set(successor.value, (incoming.get(successor.value) ?? 0) + 1);
      if (instruction.flow.kind !== 'fallthrough') leaders.add(successor.value);
    }
  }
  for (const [address, count] of incoming) if (count !== 1) leaders.add(address);
  const groups: DecodedInstruction[][] = [];
  let group: DecodedInstruction[] = [];
  for (const instruction of sorted) {
    context.checkpoint(1);
    const previous = group.at(-1);
    if (
      previous &&
      (leaders.has(instruction.address.value) ||
        previous.validity !== 'valid' ||
        previous.flow.kind !== 'fallthrough' ||
        previous.flow.next.value !== instruction.address.value)
    ) {
      groups.push(group);
      group = [];
    }
    group.push(instruction);
  }
  if (group.length) groups.push(group);
  const blockAt = new Map<bigint, string>();
  for (const members of groups) {
    const id = entityIdentity(input.slice_id, 'block', {
      function: input.function_id,
      entry: members[0]!.address.value,
    });
    for (const instruction of members) blockAt.set(instruction.address.value, id);
  }
  return groups.map((members) => {
    context.checkpoint(1);
    const first = members[0]!;
    const last = members.at(-1)!;
    const id = blockAt.get(first.address.value)!;
    const evidence_ids = input.evidence.get(last.id) ?? last.evidence_ids;
    const edges: CFGEdge[] = [];
    const edge = (kind: CFGEdge['kind'], target: Address | null, conditional: boolean): void => {
      edges.push({
        from: id,
        to: target && kind !== 'tail_call' ? (blockAt.get(target.value) ?? null) : null,
        target,
        kind,
        conditional,
        evidence_ids,
      });
    };
    if (last.validity !== 'valid') edge('unknown', null, false);
    else {
      const flow = last.flow;
      switch (flow.kind) {
        case 'fallthrough':
          edge('fallthrough', flow.next, false);
          break;
        case 'call': {
          const noreturn =
            !flow.indirect && flow.target
              ? input.noreturn_calls?.get(flow.target.value)
              : undefined;
          if (noreturn)
            edges.push({
              from: id,
              to: null,
              target: null,
              kind: 'trap',
              conditional: false,
              evidence_ids: [...new Set([...evidence_ids, ...noreturn])],
            });
          else edge('fallthrough', flow.fallthrough, false);
          break;
        }
        case 'branch':
          edge(
            !flow.conditional &&
              flow.target.value !== input.entry.value &&
              input.function_entries.has(flow.target.value)
              ? 'tail_call'
              : 'branch',
            flow.target,
            flow.conditional,
          );
          if (flow.fallthrough) edge('fallthrough', flow.fallthrough, true);
          break;
        case 'indirect_branch': {
          const targets = tableTargets(last);
          if (targets) {
            const seen = new Set<bigint>();
            for (const target of targets)
              if (!seen.has(target.value)) {
                seen.add(target.value);
                edge('branch', target, true);
              }
          } else edge('unknown', null, flow.conditional);
          if (flow.fallthrough) edge('fallthrough', flow.fallthrough, true);
          break;
        }
        case 'trap':
          edge('trap', null, flow.conditional);
          if (flow.fallthrough) edge('fallthrough', flow.fallthrough, true);
          break;
        case 'return':
          edge('return', null, false);
          break;
        case 'unknown':
          edge('unknown', null, false);
          for (const successor of instructionSuccessors(last)) edge('fallthrough', successor, true);
          break;
      }
    }
    return {
      id,
      ranges: [
        {
          start: first.address,
          size: last.address.value + BigInt(last.size) - first.address.value,
        },
      ],
      instructions: members.map((instruction) => instruction.id),
      edges,
    };
  });
}
