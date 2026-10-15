import { entityIdentity, fingerprint, type FunctionGraph, type Internal, type OperationContext, type lineageSchema } from '../../core/index.js';
import type { z } from 'zod';

export type DiscoveryLineage = Internal<z.infer<typeof lineageSchema>>;
interface EntityShape { readonly id: string; readonly entry: bigint; readonly members: readonly string[]; readonly evidence_ids: readonly string[] }

/** Exact ownership preserves births. Connected ownership changes with multiple predecessors or
 * successors mint fresh IDs for every participant. This is lineage, not annotation migration.
 * One-to-one extension of a function/block keeps its original entry birth.
 */
function reconcile(slice: string, kind: string, previous: readonly EntityShape[], next: readonly EntityShape[], revision: number, context: OperationContext): { ids: ReadonlyMap<string, string>; lineage: DiscoveryLineage[] } {
  const ids = new Map<string, string>();
  const lineage: DiscoveryLineage[] = [];
  const oldByShape = new Map<string, EntityShape>();
  for (const entity of previous) {
    context.checkpoint(entity.members.length + 1);
    oldByShape.set(fingerprint([entity.entry, [...entity.members].sort()]), entity);
  }
  const matched = new Set<string>();
  const pending: EntityShape[] = [];
  for (const entity of next) {
    context.checkpoint(entity.members.length + 1);
    const old = oldByShape.get(fingerprint([entity.entry, [...entity.members].sort()]));
    if (old) { ids.set(entity.id, old.id); matched.add(old.id); } else pending.push(entity);
  }
  const remaining = previous.filter(entity => !matched.has(entity.id));
  const owners = new Map<string, number[]>();
  for (let i = 0; i < remaining.length; i++) {
    for (const member of remaining[i]!.members) {
      context.checkpoint(1);
      const values = owners.get(member);
      if (values) values.push(i); else owners.set(member, [i]);
    }
  }
  const oldToNew = new Map<number, number[]>();
  const newToOld = new Map<number, Set<number>>();
  for (let i = 0; i < pending.length; i++) {
    const neighbors = new Set<number>();
    for (const member of pending[i]!.members) {
      context.checkpoint(1);
      for (const owner of owners.get(member) ?? []) { context.checkpoint(1); neighbors.add(owner); }
    }
    newToOld.set(i, neighbors);
    for (const owner of neighbors) {
      const values = oldToNew.get(owner);
      if (values) values.push(i); else oldToNew.set(owner, [i]);
    }
  }
  const seen = new Set<number>();
  for (let i = 0; i < pending.length; i++) {
    if (seen.has(i)) continue;
    const newIndices = new Set<number>();
    const oldIndices = new Set<number>();
    const queue = [i];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      context.checkpoint(1);
      const current = queue[cursor]!;
      if (seen.has(current)) continue;
      seen.add(current); newIndices.add(current);
      for (const old of newToOld.get(current) ?? []) {
        if (oldIndices.has(old)) continue;
        oldIndices.add(old);
        queue.push(...oldToNew.get(old) ?? []);
      }
    }
    const predecessors = [...oldIndices].map(index => remaining[index]!);
    const successors = [...newIndices].map(index => pending[index]!);
    if (!predecessors.length) continue;
    if (predecessors.length === 1 && successors.length === 1 && predecessors[0]!.entry === successors[0]!.entry) {
      ids.set(successors[0]!.id, predecessors[0]!.id); continue;
    }
    const reason = predecessors.length === 1 && successors.length > 1 ? 'split' : predecessors.length > 1 && successors.length === 1 ? 'merge' : 'replacement';
    const previousIds = predecessors.map(entity => entity.id).sort();
    const shape = successors.map(entity => fingerprint([entity.entry, [...entity.members].sort()])).sort();
    const nextIds = successors.map(entity => {
      const id = entityIdentity(slice, kind, { previous: previousIds, shape, entry: entity.entry });
      ids.set(entity.id, id); return id;
    }).sort();
    lineage.push({ revision, reason, previous: previousIds, next: nextIds, evidence_ids: [...new Set(successors.flatMap(entity => entity.evidence_ids))] });
  }
  return { ids, lineage };
}

export function reconcileGraphs(graphs: readonly FunctionGraph[], previous: readonly FunctionGraph[], revision: number, slice: string, context: OperationContext): { graphs: readonly FunctionGraph[]; lineage: readonly DiscoveryLineage[] } {
  const functionShape = (graph: FunctionGraph): EntityShape => ({ id: graph.function.id, entry: graph.function.entry.value, members: graph.instructions.map(instruction => instruction.id), evidence_ids: graph.function.evidence_ids });
  const functions = reconcile(slice, 'function-successor', previous.map(functionShape), graphs.map(functionShape), revision, context);
  const rebased = graphs.map(graph => {
    const functionId = functions.ids.get(graph.function.id) ?? graph.function.id;
    if (functionId === graph.function.id) return graph;
    const ids = new Map(graph.blocks.map(block => [block.id, entityIdentity(slice, 'block', { function: functionId, entry: block.ranges[0]!.start.value })]));
    return { ...graph, function: { ...graph.function, id: functionId }, blocks: graph.blocks.map(block => ({ ...block, id: ids.get(block.id)!,
      edges: block.edges.map(edge => ({ ...edge, from: ids.get(edge.from)!, to: edge.to === null ? null : ids.get(edge.to) ?? edge.to })) })) };
  });
  const blockShapes = (items: readonly FunctionGraph[]): EntityShape[] => items.flatMap(graph => graph.blocks.map(block => ({ id: block.id, entry: block.ranges[0]!.start.value, members: block.instructions, evidence_ids: graph.function.evidence_ids })));
  // Function ownership is included in block membership: identical shared tails remain distinct blocks.
  const previousBlocks = previous.flatMap(graph => blockShapes([graph]).map(block => ({ ...block, members: block.members.map(member => `${graph.function.id}:${member}`) })));
  const nextBlocks = rebased.flatMap(graph => blockShapes([graph]).map(block => ({ ...block, members: block.members.map(member => `${graph.function.id}:${member}`) })));
  const blocks = reconcile(slice, 'block-successor', previousBlocks, nextBlocks, revision, context);
  return {
    graphs: rebased.map(graph => ({ ...graph, blocks: graph.blocks.map(block => ({ ...block, id: blocks.ids.get(block.id) ?? block.id,
      edges: block.edges.map(edge => ({ ...edge, from: blocks.ids.get(edge.from) ?? edge.from, to: edge.to === null ? null : blocks.ids.get(edge.to) ?? edge.to })) })) })),
    lineage: [...functions.lineage, ...blocks.lineage],
  };
}
