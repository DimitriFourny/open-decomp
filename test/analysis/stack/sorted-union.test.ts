import assert from 'node:assert/strict';
import test from 'node:test';
import { sortedUnion } from '../../../src/analysis/stack/sorted-union.js';

let state = 12345;
const next = (): number => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state;
};
const pool = Array.from(
  { length: 24 },
  (_, i) => `entity_${(i * 7919).toString(16).padStart(8, '0')}`,
);
const reference = (lists: readonly (readonly string[])[]): string[] =>
  [...new Set(lists.flat())].sort();
const pick = (size: number): string[] =>
  Array.from({ length: size }, () => pool[next() % pool.length]!);
const sortedUnique = (size: number): string[] => reference([pick(size)]);

test('sortedUnion equals the Set-and-sort reference for every input shape', () => {
  for (let round = 0; round < 3000; round++) {
    const count = next() % 4;
    const lists: string[][] = [];
    for (let k = 0; k < count; k++) {
      const size = next() % 6;
      // Mix provably sorted-unique lists (fast path) with arbitrary ones (generic path).
      lists.push(next() % 3 === 0 ? pick(size) : sortedUnique(size));
    }
    assert.deepEqual(sortedUnion(...lists), reference(lists), JSON.stringify(lists));
  }
});

test('sortedUnion never aliases or mutates its inputs', () => {
  const a = ['a', 'c'],
    b: string[] = [];
  const only = sortedUnion(a, b);
  assert.deepEqual(only, a);
  assert.notEqual(only, a);
  only.push('z');
  assert.deepEqual(a, ['a', 'c']);
  const unsorted = ['c', 'a', 'c'];
  assert.deepEqual(sortedUnion(unsorted, ['b']), ['a', 'b', 'c']);
  assert.deepEqual(unsorted, ['c', 'a', 'c']);
});

test('sortedUnion handles equal lists, empty lists and single elements', () => {
  assert.deepEqual(sortedUnion(), []);
  assert.deepEqual(sortedUnion([], []), []);
  assert.deepEqual(sortedUnion(['x'], ['x']), ['x']);
  assert.deepEqual(sortedUnion(['a', 'b'], ['a', 'b']), ['a', 'b']);
  assert.deepEqual(sortedUnion(['a', 'b', 'd'], ['c']), ['a', 'b', 'c', 'd']);
});
