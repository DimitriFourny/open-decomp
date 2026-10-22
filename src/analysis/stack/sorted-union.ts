/** True when every element is strictly greater than its predecessor, in the default `sort()` order. */
function strictlyIncreasing(list: readonly string[]): boolean {
  for (let index = 1; index < list.length; index++)
    if (list[index - 1]! >= list[index]!) return false;
  return true;
}
/**
 * `[...new Set(lists.flat())].sort()` with fast paths. Lists that are already strictly
 * increasing (the form every combined fact has) are merged without a Set or a sort; any
 * other input takes the generic path, so the result is the same array content either way.
 */
export function sortedUnion<T extends string>(...lists: readonly (readonly T[])[]): T[] {
  let nonEmpty = 0,
    only: readonly T[] = [];
  for (const list of lists)
    if (list.length > 0) {
      nonEmpty++;
      only = list;
    }
  if (nonEmpty === 0) return [];
  if (lists.every(strictlyIncreasing)) {
    if (nonEmpty === 1) return only.slice();
    if (nonEmpty === 2) {
      const [a, b] = lists.filter((list) => list.length > 0) as [readonly T[], readonly T[]];
      const out: T[] = [];
      let i = 0,
        j = 0;
      while (i < a.length && j < b.length) {
        const x = a[i]!,
          y = b[j]!;
        if (x < y) {
          out.push(x);
          i++;
        } else if (y < x) {
          out.push(y);
          j++;
        } else {
          out.push(x);
          i++;
          j++;
        }
      }
      while (i < a.length) out.push(a[i++]!);
      while (j < b.length) out.push(b[j++]!);
      return out;
    }
  }
  return [...new Set(lists.flat())].sort();
}
