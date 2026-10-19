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

/** Exact image-level identity of one pointer flow at displacement zero: the
 * value a function receives in an integer argument register, returns in its
 * result register, or the address of one entry-SP-relative stack object. */
export type ImageTypeAnchor =
  | { readonly kind: 'argument'; readonly function_id: string; readonly index: number }
  | { readonly kind: 'return'; readonly function_id: string }
  | { readonly kind: 'stack'; readonly function_id: string; readonly offset: bigint };

/** One function-local object view: a recovered memory shape, or a pointer value
 * that flows between functions. Fields are relative to the anchored pointer. */
export interface ImageTypeObject {
  /** Image-unique key; also the deterministic ordering key. */
  readonly key: string;
  readonly function_id: string;
  readonly fields: readonly ImageTypeField[];
  /** `own` anchors are this function's entry arguments/result (callee side);
   * the others are uses at call sites (caller side) or stack addresses. */
  readonly anchors: readonly { readonly anchor: ImageTypeAnchor; readonly own: boolean }[];
  /** Members whose loaded or stored value is exactly another local object. */
  readonly pointees: readonly {
    readonly offset: bigint;
    readonly stride: bigint | null;
    readonly object: string;
  }[];
}

export interface ImageTypeFunction {
  /** C identifier of the function. */
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
  /** Bounded: some flow into or out of this class was not explored, so the
   * member set (and name) may depend on where exploration started. */
  readonly state: 'complete' | 'bounded';
  /** Classes a flow connected to this one whose layouts overlap incompatibly. */
  readonly conflicts: readonly string[];
  /** No flow or holder identifies this class: one function's private view. */
  readonly local: boolean;
}

export interface ImageTypeSolution {
  readonly classes: readonly ImageTypeClass[];
  /** Object key to class ID. */
  readonly class_of: ReadonlyMap<string, string>;
}

export interface ImageTypeSolveOptions {
  readonly functions: ReadonlyMap<string, ImageTypeFunction>;
  /** Functions whose own anchors were never observed (body unavailable). */
  readonly unloaded: ReadonlySet<string>;
  /** Anchor keys whose caller side was not fully explored. */
  readonly open: ReadonlySet<string>;
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
export const compareImageFields = (a: ImageTypeField, b: ImageTypeField): number =>
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
export function compatibleImageFields(
  left: readonly ImageTypeField[],
  right: readonly ImageTypeField[],
  budget: AnalysisBudget,
): boolean {
  const all = [
    ...left.map((field) => ({ field, side: 0 })),
    ...right.map((field) => ({ field, side: 1 })),
  ].sort((a, b) => compareImageFields(a.field, b.field));
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
    merged.set(
      key,
      previous
        ? {
            ...previous,
            stride: previous.stride ?? field.stride,
            kind: previous.kind === 'pointer' || field.kind === 'pointer' ? 'pointer' : previous.kind,
          }
        : field,
    );
  }
  return [...merged.values()].sort(compareImageFields);
}

interface Root {
  members: string[];
  fields: ImageTypeField[];
  pointees: Map<string, { offset: bigint; stride: bigint | null; object: string }>;
}

/** Unification (Steensgaard-style) of function-local object views connected by
 * exact pointer flows and by the pointees of unified members. An argument or
 * result flow is used only once the callee itself confirms it as an object
 * (it dereferences the value, or passes/returns it into a confirmed flow), so a
 * stale caller register never joins unrelated objects. A union whose layouts
 * overlap incompatibly is refused and recorded as a conflict: distinct layouts
 * never share a class. Flows are processed in canonical key order. */
export function solveImageTypes(
  objects: readonly ImageTypeObject[],
  options: ImageTypeSolveOptions,
  budget: AnalysisBudget,
): ImageTypeSolution {
  const sorted = [...objects].sort((a, b) => a.key.localeCompare(b.key));
  const byKey = new Map(sorted.map((object) => [object.key, object]));
  const anchored = new Map<string, string[]>();
  const owners = new Map<string, string[]>();
  for (const object of sorted)
    for (const { anchor, own } of object.anchors) {
      budget.charge();
      const key = imageAnchorKey(anchor);
      (anchored.get(key) ?? anchored.set(key, []).get(key)!).push(object.key);
      if (own) (owners.get(key) ?? owners.set(key, []).get(key)!).push(object.key);
    }
  // Least fixpoint: a stack anchor is local; an argument/result anchor needs a
  // callee-side object that dereferences the value or forwards it to one.
  const confirmed = new Set<string>();
  for (const key of anchored.keys()) if (key.startsWith('stack:')) confirmed.add(key);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [key, list] of owners) {
      if (confirmed.has(key)) continue;
      budget.charge(list.length);
      if (
        list.some((member) => {
          const object = byKey.get(member)!;
          return (
            object.fields.length > 0 ||
            object.pointees.length > 0 ||
            object.anchors.some(
              (item) => !item.own && confirmed.has(imageAnchorKey(item.anchor)),
            )
          );
        })
      ) {
        confirmed.add(key);
        changed = true;
      }
    }
  }
  const parent = new Map<string, string>();
  const roots = new Map<string, Root>();
  const queue: [string, string][] = [];
  for (const object of sorted) {
    budget.charge(1 + object.fields.length + object.pointees.length);
    parent.set(object.key, object.key);
    const pointees = new Map<string, { offset: bigint; stride: bigint | null; object: string }>();
    for (const pointee of [...object.pointees].sort((a, b) => a.object.localeCompare(b.object))) {
      const key = pointeeKey(pointee.offset, pointee.stride),
        previous = pointees.get(key);
      // One member read at several places holds one pointee type.
      if (previous) queue.push([previous.object, pointee.object]);
      else pointees.set(key, pointee);
    }
    roots.set(object.key, {
      members: [object.key],
      fields: [...object.fields].sort(compareImageFields),
      pointees,
    });
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
  function union(a: string, b: string): void {
    const left = find(a),
      right = find(b);
    if (left === right) return;
    if (!compatibleImageFields(roots.get(left)!.fields, roots.get(right)!.fields, budget)) {
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
    for (let index = 0; index < queue.length; index++) {
      budget.charge();
      union(...queue[index]!);
    }
    queue.length = 0;
  };
  drain();
  for (const key of [...anchored.keys()].sort()) {
    if (!confirmed.has(key)) continue;
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
    (groups.get(root) ?? groups.set(root, []).get(root)!).push(object.key);
  }
  const ids = new Map<string, string>();
  for (const [root, members] of groups)
    ids.set(root, `image_type_${fingerprint(members).slice(0, 24)}`);
  const classOf = (key: string): string => ids.get(find(key))!;
  const conflicts = new Map<string, Set<string>>();
  for (const [a, b] of refused) {
    const left = classOf(a),
      right = classOf(b);
    if (left === right) continue;
    (conflicts.get(left) ?? conflicts.set(left, new Set()).get(left)!).add(right);
    (conflicts.get(right) ?? conflicts.set(right, new Set()).get(right)!).add(left);
  }
  const functionName = (id: string): string => options.functions.get(id)?.name ?? 'sub';
  const functionOrder = (id: string): bigint => options.functions.get(id)?.order ?? 0n;
  // A flow is unexplored when its callee body is unavailable or its callers
  // were not all visited; the class may then miss members.
  const unexplored = (key: string, anchor: ImageTypeAnchor): boolean =>
    anchor.kind !== 'stack' &&
    (options.open.has(key) || options.unloaded.has(anchor.function_id));
  interface Pending {
    root: string;
    id: string;
    members: string[];
    bounded: boolean;
    name?: string;
    local?: boolean;
  }
  const classes: Pending[] = [];
  for (const [root, members] of groups)
    classes.push({
      root,
      id: ids.get(root)!,
      members,
      bounded: members.some((member) =>
        byKey
          .get(member)!
          .anchors.some(({ anchor }) => unexplored(imageAnchorKey(anchor), anchor)),
      ),
    });
  classes.sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(classes.map((item) => [item.id, item]));
  // A pointee view's members follow its holder's members: an incompletely
  // explored holder leaves its pointees incomplete too.
  for (let changed = true; changed; ) {
    changed = false;
    for (const item of classes) {
      if (!item.bounded) continue;
      for (const pointee of roots.get(item.root)!.pointees.values()) {
        budget.charge();
        const target = byId.get(classOf(pointee.object))!;
        if (!target.bounded) {
          target.bounded = true;
          changed = true;
        }
      }
    }
  }
  // Local ordinals for objects without flow identity: stable per function.
  const ordinals = new Map<string, number>();
  const counters = new Map<string, number>();
  for (const object of sorted) {
    const next = (counters.get(object.function_id) ?? 0) + 1;
    counters.set(object.function_id, next);
    ordinals.set(object.key, next);
  }
  interface Candidate {
    rank: number;
    order: bigint;
    tie: string;
    name: string;
  }
  const better = (a: Candidate, b: Candidate | undefined): boolean =>
    !b ||
    a.rank < b.rank ||
    (a.rank === b.rank &&
      (a.order < b.order || (a.order === b.order && a.tie.localeCompare(b.tie) < 0)));
  for (const item of classes) {
    let best: Candidate | undefined;
    for (const member of item.members) {
      const object = byKey.get(member)!;
      for (const { anchor, own } of object.anchors) {
        budget.charge();
        // Arguments/results name a class only through the callee's own view
        // in it: a caller's use may have been refused as a conflict.
        if (anchor.kind !== 'stack' && !own) continue;
        const fn = functionName(anchor.function_id),
          order = functionOrder(anchor.function_id);
        // Interface roles name a type before a caller's stack slot does.
        const candidate: Candidate =
          anchor.kind === 'stack'
            ? {
                rank: 2,
                order,
                tie: `${anchor.offset}`,
                name: `${fn}_local_${(anchor.offset < 0n ? -anchor.offset : anchor.offset).toString(16)}`,
              }
            : anchor.kind === 'argument'
              ? { rank: 0, order, tie: `${anchor.index}`, name: `${fn}_arg${anchor.index}` }
              : { rank: 1, order, tie: '', name: `${fn}_ret` };
        if (better(candidate, best)) best = candidate;
      }
    }
    if (best) item.name = best.name;
  }
  const pointeesOf = (item: Pending) =>
    [...roots.get(item.root)!.pointees.values()].sort((a, b) =>
      a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : a.object.localeCompare(b.object),
    );
  // Pointee classes without their own flow identity are named after the
  // member holding them, in deterministic rounds (bounded depth).
  for (let round = 0; round < 4; round++) {
    const named = new Map<string, string>();
    for (const item of classes) {
      if (!item.name) continue;
      for (const pointee of pointeesOf(item)) {
        budget.charge();
        const target = byId.get(classOf(pointee.object))!;
        if (target.name || named.has(target.id)) continue;
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
    const first = [...item.members].sort((a, b) => {
      const x = byKey.get(a)!,
        y = byKey.get(b)!;
      const order = functionOrder(x.function_id) - functionOrder(y.function_id);
      return order < 0n ? -1 : order > 0n ? 1 : ordinals.get(a)! - ordinals.get(b)!;
    })[0]!;
    const object = byKey.get(first)!;
    item.name = `${functionName(object.function_id)}_obj${ordinals.get(object.key)}`;
    item.local = item.members.length === 1;
  }
  const result: ImageTypeClass[] = [];
  const class_of = new Map<string, string>();
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
        class_id: classOf(pointee.object),
      })),
      state: item.bounded ? 'bounded' : 'complete',
      conflicts: [...(conflicts.get(item.id) ?? [])].sort(),
      local: item.local === true,
    });
  }
  // A bounded member set may differ by exploration root: its name carries a
  // digest of the merged layout, so one name never denotes two layouts.
  for (const [index, item] of result.entries())
    if (item.state === 'bounded')
      result[index] = {
        ...item,
        name: `${item.name}_${fingerprint(
          item.fields.map((field) => [
            field.offset.toString(),
            field.width_bits,
            field.stride?.toString() ?? null,
            field.kind,
          ]),
        ).slice(0, 4)}`,
      };
  // Refused unions can leave two classes with the same base name.
  const used = new Map<string, number>();
  for (const [index, item] of result.entries()) {
    const count = (used.get(item.name) ?? 0) + 1;
    used.set(item.name, count);
    if (count > 1) result[index] = { ...item, name: `${item.name}_${count}` };
  }
  return { classes: result, class_of };
}
