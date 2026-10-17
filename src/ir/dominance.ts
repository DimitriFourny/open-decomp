import type { EntityId } from '../core/index.js';
import { successors } from './model.js';
import type { BasicBlock, RegisterBinding } from './model.js';

/**
 * Dominance over every block, including unreachable components. The function
 * entry is the first root; each block not reached from earlier roots (in block
 * order) starts another root. A virtual root precedes all roots, so no block in
 * one component dominates a block reachable from another root. Edges to missing
 * targets are ignored here; verification reports them separately.
 */
export interface Dominance {
  readonly roots: readonly EntityId[];
  isRoot(block: EntityId): boolean;
  /** Immediate dominator, or null for roots and unknown blocks. */
  idom(block: EntityId): EntityId | null;
  /** Reflexive dominance; false for unknown blocks. */
  dominates(dominator: EntityId, block: EntityId): boolean;
}

export function computeDominance(
  ir: { readonly entry: EntityId; readonly blocks: readonly BasicBlock[] },
  checkpoint?: (work: number) => void,
): Dominance {
  const count = ir.blocks.length;
  const slot = new Map<EntityId, number>();
  ir.blocks.forEach((block, index) => slot.set(block.id, index));
  checkpoint?.(count);
  const succ: number[][] = [],
    pred: number[][] = ir.blocks.map(() => []);
  for (let index = 0; index < count; index++) {
    const targets: number[] = [];
    for (const edge of successors(ir.blocks[index]!.terminator)) {
      checkpoint?.(1);
      const target = slot.get(edge.target);
      if (target === undefined) continue;
      targets.push(target);
      pred[target]!.push(index);
    }
    succ.push(targets);
  }
  // Iterative DFS; post-order numbers are shared by all components and the
  // virtual root receives the largest number.
  const post = new Int32Array(count).fill(-1);
  const order: number[] = [];
  const roots: number[] = [];
  const visited = new Uint8Array(count);
  const search = (start: number): void => {
    roots.push(start);
    visited[start] = 1;
    const stack: [number, number][] = [[start, 0]];
    while (stack.length) {
      checkpoint?.(1);
      const top = stack[stack.length - 1]!;
      const next = succ[top[0]]![top[1]++];
      if (next === undefined) {
        stack.pop();
        post[top[0]] = order.length;
        order.push(top[0]);
      } else if (!visited[next]) {
        visited[next] = 1;
        stack.push([next, 0]);
      }
    }
  };
  const entry = slot.get(ir.entry);
  if (entry !== undefined) search(entry);
  for (let index = 0; index < count; index++) if (!visited[index]) search(index);
  const virtual = count;
  const idom = new Int32Array(count + 1).fill(-1);
  const rootFlag = new Uint8Array(count);
  for (const root of roots) {
    idom[root] = virtual;
    rootFlag[root] = 1;
  }
  idom[virtual] = virtual;
  const number = (node: number): number => (node === virtual ? count : post[node]!);
  let changed = true;
  while (changed) {
    changed = false;
    for (let cursor = order.length - 1; cursor >= 0; cursor--) {
      const node = order[cursor]!;
      if (rootFlag[node]) continue;
      let candidate = -1;
      for (const p of pred[node]!) {
        checkpoint?.(1);
        if (idom[p] === -1) continue;
        if (candidate === -1) {
          candidate = p;
          continue;
        }
        let a = p,
          b = candidate;
        while (a !== b) {
          checkpoint?.(1);
          while (number(a) < number(b)) a = idom[a]!;
          while (number(b) < number(a)) b = idom[b]!;
        }
        candidate = a;
      }
      if (candidate !== -1 && idom[node] !== candidate) {
        idom[node] = candidate;
        changed = true;
      }
    }
  }
  // Dominator-tree intervals give constant-time dominance queries.
  const children: number[][] = Array.from({ length: count + 1 }, () => []);
  for (let index = 0; index < count; index++) {
    checkpoint?.(1);
    children[idom[index]!]!.push(index);
  }
  const enter = new Int32Array(count + 1),
    leave = new Int32Array(count + 1);
  let clock = 0;
  const walk: [number, number][] = [[virtual, 0]];
  enter[virtual] = clock++;
  while (walk.length) {
    checkpoint?.(1);
    const top = walk[walk.length - 1]!;
    const child = children[top[0]]![top[1]++];
    if (child === undefined) {
      walk.pop();
      leave[top[0]] = clock++;
    } else {
      enter[child] = clock++;
      walk.push([child, 0]);
    }
  }
  const rootIds = roots.map((root) => ir.blocks[root]!.id);
  const rootSet = new Set(rootIds);
  return Object.freeze({
    roots: rootIds,
    isRoot: (block: EntityId) => rootSet.has(block),
    idom(block: EntityId): EntityId | null {
      const index = slot.get(block);
      const parent = index === undefined ? virtual : idom[index]!;
      return parent === virtual ? null : ir.blocks[parent]!.id;
    },
    dominates(dominator: EntityId, block: EntityId): boolean {
      const a = slot.get(dominator),
        b = slot.get(block);
      return a !== undefined && b !== undefined && enter[a]! <= enter[b]! && leave[b]! <= leave[a]!;
    },
  });
}

/**
 * Derived architectural state at a block boundary. SSA stores entry rows only
 * for cells merged or rebound at that block (every cell at roots) and exit rows
 * only for cells whose block-end value may differ from block entry (every cell
 * at function exits). Unlisted cells inherit the immediate dominator's exit.
 * Returns null when no row on the dominator chain binds this exact cell.
 */
export function registerStateAt(
  rows: {
    idom(block: EntityId): EntityId | null;
    entry(block: EntityId): readonly RegisterBinding[];
    exit(block: EntityId): readonly RegisterBinding[];
  },
  block: EntityId,
  cell: { readonly root: string; readonly offset_bits: number; readonly width_bits: number },
  boundary: 'entry' | 'exit',
  checkpoint?: (work: number) => void,
): RegisterBinding | null {
  const find = (bindings: readonly RegisterBinding[]): RegisterBinding | undefined =>
    bindings.find((binding) => {
      checkpoint?.(1);
      return (
        binding.register.root === cell.root &&
        binding.register.offset_bits === cell.offset_bits &&
        binding.register.width_bits === cell.width_bits
      );
    });
  let current: EntityId | null = block,
    side = boundary;
  while (current !== null) {
    checkpoint?.(1);
    if (side === 'exit') {
      const found = find(rows.exit(current));
      if (found) return found;
    }
    const found = find(rows.entry(current));
    if (found) return found;
    current = rows.idom(current);
    side = 'exit';
  }
  return null;
}
