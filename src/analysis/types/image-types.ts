import { fingerprint } from '../../core/index.js';
import type { AnalysisBudget } from '../ssa/budget.js';

/** Observed member of one local object view; kind is the strongest local use. */
export interface ImageTypeField {
  readonly offset: bigint;
  readonly width_bits: number;
  /** Proven element period of a strided access; the element count is unknown. */
  readonly stride: bigint | null;
  readonly kind: 'integer' | 'float' | 'pointer';
}

/** Exact image-level identity of one pointer value at displacement zero:
 * the value a function receives in an integer argument register, returns in
 * its result register, or the address of one entry-SP-relative stack object. */
export type ImageTypeAnchor =
  | { readonly kind: 'argument'; readonly function_id: string; readonly index: number }
  | { readonly kind: 'return'; readonly function_id: string }
  | { readonly kind: 'stack'; readonly function_id: string; readonly offset: bigint };

/** One function-local object view (a recovered memory shape or a pointer value
 * that flows between functions). Fields are relative to the anchored pointer. */
export interface ImageTypeObject {
  /** Image-unique key; also the deterministic local ordering key. */
  readonly key: string;
  readonly function_id: string;
  readonly fields: readonly ImageTypeField[];
  readonly anchors: readonly ImageTypeAnchor[];
  /** Members whose loaded or stored value is exactly another local object. */
  readonly pointees: readonly {
    readonly offset: bigint;
    readonly stride: bigint | null;
    readonly object: string;
  }[];
}

export interface ImageTypeFunction {
  /** C identifier of the function (`sub_<entry>` when unnamed). */
  readonly name: string;
  /** Deterministic order (entry address). */
  readonly order: bigint;
}

export interface ImageTypeClass {
  /** Stable identity of the merged member set. */
  readonly id: string;
  readonly name: string;
  readonly members: readonly string[];
  readonly functions: readonly string[];
  /** Union of compatible observed members, sorted by offset. */
  readonly fields: readonly ImageTypeField[];
  readonly pointees: readonly {
    readonly offset: bigint;
    readonly stride: bigint | null;
    readonly class_id: string;
  }[];
  /** Bounded: some flow into or out of this class was not explored. */
  readonly state: 'complete' | 'bounded';
  /** Classes a flow connected to this one whose layouts overlap incompatibly. */
  readonly conflicts: readonly string[];
}

export interface ImageTypeSolution {
  readonly classes: readonly ImageTypeClass[];
  /** Object key to class ID. */
  readonly class_of: ReadonlyMap<string, string>;
}

export interface ImageTypeSolveOptions {
  readonly functions: ReadonlyMap<string, ImageTypeFunction>;
  /** Anchor keys whose flows were not explored (bounded neighborhood). */
  readonly open: ReadonlySet<string>;
  /** Bounded classes take their name from this function's own objects. */
  readonly root_function?: string;
}

export function imageAnchorKey(anchor: ImageTypeAnchor): string {
  return anchor.kind === 'argument'
    ? `argument:${anchor.function_id}:${anchor.index}`
    : anchor.kind === 'return'
      ? `return:${anchor.function_id}`
      : `stack:${anchor.function_id}:${anchor.offset}`;
}

const pointeeKey = (offset: bigint, stride: bigint | null): string => `${offset}:${stride ?? ''}`;
const fieldEnd = (field: ImageTypeField): bigint =>
  field.offset + BigInt(Math.ceil(field.width_bits / 8));
const compareFields = (a: ImageTypeField, b: ImageTypeField): number =>
  a.offset < b.offset
    ? -1
    : a.offset > b.offset
      ? 1
      : a.width_bits - b.width_bits || String(a.stride).localeCompare(String(b.stride));

/** Two observations of the same bytes are one member when offset, width and
 * any proven period agree and they are not float versus integer storage. */
function sameMember(a: ImageTypeField, b: ImageTypeField): boolean {
  return (
    a.offset === b.offset &&
    a.width_bits === b.width_bits &&
    (a.stride === null || b.stride === null || a.stride === b.stride) &&
    (a.kind === 'float') === (b.kind === 'float')
  );
}

/** Every pair of overlapping members taken from different sides is one member. */
function compatible(
  left: readonly ImageTypeField[],
  right: readonly ImageTypeField[],
  budget: AnalysisBudget,
): boolean {
  const all = [
    ...left.map((field) => ({ field, side: 0 })),
    ...right.map((field) => ({ field, side: 1 })),
  ].sort((a, b) => compareFields(a.field, b.field));
  for (let index = 0; index < all.length; index++) {
    const current = all[index]!,
      end = fieldEnd(current.field);
    for (let next = index + 1; next < all.length && all[next]!.field.offset < end; next++) {
      budget.charge();
      const other = all[next]!;
      if (other.side !== current.side && !sameMember(current.field, other.field)) return false;
    }
  }
  return true;
}

function mergeFields(
  left: readonly ImageTypeField[],
  right: readonly ImageTypeField[],
): ImageTypeField[] {
  const merged = new Map<string, ImageTypeField>();
  for (const field of [...left, ...right]) {
    const key = `${field.offset}:${field.width_bits}:${field.kind === 'float'}`;
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, field);
      continue;
    }
    if (previous.stride !== null && field.stride !== null && previous.stride !== field.stride) {
      merged.set(`${key}:${field.stride}`, field);
      continue;
    }
    merged.set(key, {
      ...previous,
      stride: previous.stride ?? field.stride,
      kind: previous.kind === 'pointer' || field.kind === 'pointer' ? 'pointer' : previous.kind,
    });
  }
  return [...merged.values()].sort(compareFields);
}

interface Root {
  members: string[];
  fields: ImageTypeField[];
  pointees: Map<string, { offset: bigint; stride: bigint | null; object: string }>;
}

/** Steensgaard-style unification of function-local object views connected by
 * exact pointer flows (arguments, results, stack addresses) and by the
 * pointees of unified members. A union whose layouts overlap incompatibly is
 * refused and recorded as a conflict, so distinct layouts never share a name.
 * Edges are processed in canonical key order: a fully explored component gets
 * the same classes, layouts and names from any of its functions. */
export function solveImageTypes(
  objects: readonly ImageTypeObject[],
  options: ImageTypeSolveOptions,
  budget: AnalysisBudget,
): ImageTypeSolution {
  const sorted = [...objects].sort((a, b) => a.key.localeCompare(b.key));
  const byKey = new Map(sorted.map((object) => [object.key, object]));
  const parent = new Map<string, string>();
  const roots = new Map<string, Root>();
  const deferred: [string, string][] = [];
  for (const object of sorted) {
    budget.charge(1 + object.fields.length + object.pointees.length);
    parent.set(object.key, object.key);
    const pointees = new Map<string, { offset: bigint; stride: bigint | null; object: string }>();
    const pending: [string, string][] = [];
    for (const pointee of [...object.pointees].sort((a, b) => a.object.localeCompare(b.object))) {
      const key = pointeeKey(pointee.offset, pointee.stride),
        previous = pointees.get(key);
      if (previous) pending.push([previous.object, pointee.object]);
      else pointees.set(key, pointee);
    }
    roots.set(object.key, {
      members: [object.key],
      fields: [...object.fields].sort(compareFields),
      pointees,
    });
    deferred.push(...pending);
  }
  function find(key: string): string {
    let current = key;
    while (parent.get(current) !== current) {
      budget.charge();
      const next = parent.get(current)!;
      parent.set(current, parent.get(next)!);
      current = next;
    }
    return current;
  }
  const refused: [string, string][] = [];
  const queue: [string, string][] = [];
  function union(a: string, b: string): void {
    const left = find(a),
      right = find(b);
    if (left === right) return;
    const x = roots.get(left)!,
      y = roots.get(right)!;
    if (!compatible(x.fields, y.fields, budget)) {
      refused.push([a, b]);
      return;
    }
    // The smaller key stays the representative: deterministic, order-free.
    const [keep, drop] = left < right ? [left, right] : [right, left];
    const kept = roots.get(keep)!,
      dropped = roots.get(drop)!;
    parent.set(drop, keep);
    roots.delete(drop);
    kept.members.push(...dropped.members);
    kept.fields = mergeFields(kept.fields, dropped.fields);
    for (const [key, pointee] of dropped.pointees) {
      budget.charge();
      const previous = kept.pointees.get(key);
      if (previous) queue.push([previous.object, pointee.object]);
      else kept.pointees.set(key, pointee);
    }
  }
  const drain = (): void => {
    while (queue.length) {
      budget.charge();
      const [a, b] = queue.shift()!;
      union(a, b);
    }
  };
  // Pointees of one member read at several places are one pointee type.
  for (const [a, b] of deferred) queue.push([a, b]);
  drain();
  const anchored = new Map<string, string[]>();
  for (const object of sorted)
    for (const anchor of object.anchors) {
      budget.charge();
      const key = imageAnchorKey(anchor);
      const list = anchored.get(key) ?? [];
      list.push(object.key);
      anchored.set(key, list);
    }
  for (const key of [...anchored.keys()].sort()) {
    const members = anchored.get(key)!;
    for (const member of members.slice(1)) {
      union(members[0]!, member);
      drain();
    }
  }
  const groups = new Map<string, string[]>();
  for (const object of sorted) {
    budget.charge();
    const root = find(object.key);
    const list = groups.get(root) ?? [];
    list.push(object.key);
    groups.set(root, list);
  }
  const ids = new Map<string, string>();
  for (const [root, members] of groups)
    ids.set(root, `image_type_${fingerprint(members).slice(0, 24)}`);
  const conflicts = new Map<string, Set<string>>();
  for (const [a, b] of refused) {
    const left = ids.get(find(a))!,
      right = ids.get(find(b))!;
    if (left === right) continue;
    (conflicts.get(left) ?? conflicts.set(left, new Set()).get(left)!).add(right);
    (conflicts.get(right) ?? conflicts.set(right, new Set()).get(right)!).add(left);
  }
  const functionName = (id: string): string => options.functions.get(id)?.name ?? 'sub';
  const functionOrder = (id: string): bigint => options.functions.get(id)?.order ?? 0n;
  const classes: {
    root: string;
    id: string;
    members: string[];
    bounded: boolean;
    name?: string;
  }[] = [];
  for (const [root, members] of groups) {
    const bounded = members.some((member) =>
      byKey.get(member)!.anchors.some((anchor) => options.open.has(imageAnchorKey(anchor))),
    );
    classes.push({ root, id: ids.get(root)!, members, bounded });
  }
  classes.sort((a, b) => a.id.localeCompare(b.id));
  // Local ordinals for objects with no flow identity: stable per function.
  const ordinals = new Map<string, number>();
  const counters = new Map<string, number>();
  for (const object of sorted) {
    const next = (counters.get(object.function_id) ?? 0) + 1;
    counters.set(object.function_id, next);
    ordinals.set(object.key, next);
  }
  type Candidate = { rank: number; order: bigint; tie: string; name: string };
  const better = (a: Candidate, b: Candidate | undefined): boolean =>
    !b ||
    a.rank < b.rank ||
    (a.rank === b.rank &&
      (a.order < b.order || (a.order === b.order && a.tie.localeCompare(b.tie) < 0)));
  const ownName = (
    members: readonly string[],
    only: string | undefined,
  ): Candidate | undefined => {
    let best: Candidate | undefined;
    for (const member of members) {
      const object = byKey.get(member)!;
      if (only !== undefined && object.function_id !== only) continue;
      for (const anchor of object.anchors) {
        budget.charge();
        // Arguments/results are named by the function that owns the value.
        if (only !== undefined && anchor.function_id !== only) continue;
        const fn = functionName(anchor.function_id),
          order = functionOrder(anchor.function_id);
        const candidate: Candidate =
          anchor.kind === 'stack'
            ? {
                rank: 0,
                order,
                tie: `${anchor.offset}`,
                name: `${fn}_local_${(anchor.offset < 0n ? -anchor.offset : anchor.offset).toString(16)}`,
              }
            : anchor.kind === 'argument'
              ? { rank: 1, order, tie: `${anchor.index}`, name: `${fn}_arg${anchor.index}` }
              : { rank: 2, order, tie: '', name: `${fn}_ret` };
        if (better(candidate, best)) best = candidate;
      }
    }
    return best;
  };
  const byId = new Map(classes.map((item) => [item.id, item]));
  for (const item of classes) {
    const candidate = ownName(
      item.members,
      item.bounded ? options.root_function : undefined,
    );
    if (candidate) item.name = candidate.name;
  }
  // Pointee classes without their own flow identity are named by the member
  // that holds them, in deterministic rounds (bounded depth, cycles stop).
  const pointeesOf = (item: (typeof classes)[number]) =>
    [...roots.get(item.root)!.pointees.values()].sort((a, b) =>
      a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : a.object.localeCompare(b.object),
    );
  for (let round = 0; round < 4; round++) {
    const named = new Map<string, string>();
    for (const item of classes) {
      if (!item.name) continue;
      for (const pointee of pointeesOf(item)) {
        budget.charge();
        const target = byId.get(ids.get(find(pointee.object))!)!;
        if (target.name || named.has(target.id)) continue;
        if (item.bounded !== target.bounded && target.bounded) continue;
        named.set(
          target.id,
          `${item.name}_f${pointee.offset.toString(16)}${pointee.stride === null ? '' : 'e'}`,
        );
      }
    }
    if (!named.size) break;
    for (const [id, name] of named) byId.get(id)!.name = name;
  }
  for (const item of classes) {
    if (item.name) continue;
    const first = [...item.members]
      .filter((member) =>
        item.bounded && options.root_function !== undefined
          ? byKey.get(member)!.function_id === options.root_function
          : true,
      )
      .sort((a, b) => {
        const x = byKey.get(a)!,
          y = byKey.get(b)!;
        const order = functionOrder(x.function_id) - functionOrder(y.function_id);
        return order < 0n ? -1 : order > 0n ? 1 : ordinals.get(a)! - ordinals.get(b)!;
      })[0];
    const object = byKey.get(first ?? item.members[0]!)!;
    item.name = `${functionName(object.function_id)}_obj${ordinals.get(object.key)}`;
    // A bounded view without a member of the requesting function cannot be
    // named canonically; its member set disambiguates it.
    if (item.bounded && first === undefined) item.name += `_${item.id.slice(-4)}`;
  }
  const used = new Map<string, number>();
  for (const item of classes) {
    const count = (used.get(item.name!) ?? 0) + 1;
    used.set(item.name!, count);
    if (count > 1) item.name = `${item.name}_${count}`;
  }
  const class_of = new Map<string, string>();
  const result: ImageTypeClass[] = [];
  for (const item of classes) {
    const root = roots.get(item.root)!;
    for (const member of item.members) class_of.set(member, item.id);
    result.push({
      id: item.id,
      name: item.name!,
      members: [...item.members].sort(),
      functions: [...new Set(item.members.map((member) => byKey.get(member)!.function_id))].sort(),
      fields: root.fields,
      pointees: pointeesOf(item).map((pointee) => ({
        offset: pointee.offset,
        stride: pointee.stride,
        class_id: ids.get(find(pointee.object))!,
      })),
      state: item.bounded ? 'bounded' : 'complete',
      conflicts: [...(conflicts.get(item.id) ?? [])].sort(),
    });
  }
  return { classes: result, class_of };
}
