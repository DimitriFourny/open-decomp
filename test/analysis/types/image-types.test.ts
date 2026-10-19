import assert from 'node:assert/strict';
import test from 'node:test';
import { AnalysisBudget } from '../../../src/analysis/ssa/budget.js';
import {
  solveImageTypes,
  type ImageTypeAnchor,
  type ImageTypeField,
  type ImageTypeObject,
  type ImageTypeSolution,
} from '../../../src/analysis/types/image-types.js';

const functions = new Map([
  ['caller', { name: 'caller', order: 0x100n }],
  ['first', { name: 'first', order: 0x200n }],
  ['second', { name: 'second', order: 0x300n }],
]);
const word = (offset: bigint, width_bits = 32): ImageTypeField => ({
  offset,
  width_bits,
  stride: null,
  kind: 'integer',
});
const argument = (function_id: string, index = 0): ImageTypeAnchor => ({
  kind: 'argument',
  function_id,
  index,
});
function object(
  key: string,
  function_id: string,
  fields: readonly ImageTypeField[],
  anchors: readonly { anchor: ImageTypeAnchor; own: boolean }[],
  pointees: ImageTypeObject['pointees'] = [],
): ImageTypeObject {
  return { key, function_id, fields, anchors, pointees };
}
const solve = (
  objects: readonly ImageTypeObject[],
  open: readonly string[] = [],
  unloaded: readonly string[] = [],
) =>
  solveImageTypes(
    objects,
    { functions, open: new Set(open), unloaded: new Set(unloaded) },
    new AnalysisBudget({ max_work: 100000 }),
  );
const classOf = (solution: ImageTypeSolution, key: string) =>
  solution.classes.find((item) => item.id === solution.class_of.get(key))!;

// One caller passes the same pointer to two callees: one object, one name.
const shared = [
  object('caller|p', 'caller', [], [
    { anchor: argument('first'), own: false },
    { anchor: argument('second'), own: false },
  ]),
  object('first|a0', 'first', [word(0n)], [{ anchor: argument('first'), own: true }]),
  object('second|a0', 'second', [word(8n, 64), word(16n)], [
    { anchor: argument('second'), own: true },
  ]),
];

test('views of one pointer flowing to two callees merge into one named layout', () => {
  const solution = solve(shared);
  const first = classOf(solution, 'first|a0');
  assert.equal(first, classOf(solution, 'second|a0'));
  assert.equal(first, classOf(solution, 'caller|p'));
  assert.deepEqual(
    first.fields.map((field) => [field.offset, field.width_bits]),
    [
      [0n, 32],
      [8n, 64],
      [16n, 32],
    ],
  );
  assert.equal(first.name, 'first_arg0');
  assert.equal(first.state, 'complete');
  assert.deepEqual(first.functions, ['caller', 'first', 'second']);
  // Input order never changes the identity or the name.
  const reversed = solve([...shared].reverse());
  assert.equal(classOf(reversed, 'second|a0').id, first.id);
  assert.equal(classOf(reversed, 'second|a0').name, first.name);
});

test('overlapping incompatible views stay separate and record the conflict', () => {
  const solution = solve([
    object('caller|p', 'caller', [], [
      { anchor: argument('first'), own: false },
      { anchor: argument('second'), own: false },
    ]),
    object('first|a0', 'first', [word(0n, 64)], [{ anchor: argument('first'), own: true }]),
    object('second|a0', 'second', [word(4n)], [{ anchor: argument('second'), own: true }]),
  ]);
  const wide = classOf(solution, 'first|a0'),
    high = classOf(solution, 'second|a0');
  assert.notEqual(wide.id, high.id);
  assert.notEqual(wide.name, high.name);
  assert.deepEqual(wide.conflicts, [high.id]);
  assert.deepEqual(high.conflicts, [wide.id]);
  // Each layout keeps only its own compatible members.
  assert.deepEqual(wide.fields, [word(0n, 64)]);
  assert.deepEqual(high.fields, [word(4n)]);
});

test('a flow the callee never uses as an object joins nothing', () => {
  // Both callers leave unrelated pointers in the third argument register;
  // `first` never dereferences or forwards its third argument.
  const solution = solve([
    object('caller|x', 'caller', [word(0n)], [{ anchor: argument('first', 2), own: false }]),
    object('second|y', 'second', [word(0n, 64)], [{ anchor: argument('first', 2), own: false }]),
    object('first|a2', 'first', [], [{ anchor: argument('first', 2), own: true }]),
  ]);
  assert.notEqual(classOf(solution, 'caller|x').id, classOf(solution, 'second|y').id);
});

test('pointee views of merged members merge as well', () => {
  const solution = solve([
    object('first|a0', 'first', [{ ...word(0x20n, 64), kind: 'pointer' }], [
      { anchor: argument('first'), own: true },
    ], [{ offset: 0x20n, stride: null, object: 'first|q' }]),
    object('first|q', 'first', [word(0n)], []),
    object('caller|p', 'caller', [{ ...word(0x20n, 64), kind: 'pointer' }], [
      { anchor: argument('first'), own: false },
    ], [{ offset: 0x20n, stride: null, object: 'caller|q' }]),
    object('caller|q', 'caller', [word(4n)], []),
  ]);
  const pointee = classOf(solution, 'first|q');
  assert.equal(pointee, classOf(solution, 'caller|q'));
  assert.deepEqual(
    pointee.fields.map((field) => field.offset),
    [0n, 4n],
  );
  assert.equal(pointee.name, 'first_arg0_f20');
  assert.deepEqual(classOf(solution, 'first|a0').pointees, [
    { offset: 0x20n, stride: null, class_id: pointee.id },
  ]);
});

test('an incompletely explored flow marks the class and its pointees bounded with a layout digest', () => {
  const objects = [
    ...shared.slice(0, 2),
    object('second|a0', 'second', [word(8n, 64), { ...word(0x18n, 64), kind: 'pointer' }], [
      { anchor: argument('second'), own: true },
    ], [{ offset: 0x18n, stride: null, object: 'second|q' }]),
    object('second|q', 'second', [word(0n)], []),
  ];
  const complete = solve(objects);
  const bounded = solve(objects, ['argument:second:0']);
  const merged = classOf(bounded, 'first|a0');
  assert.equal(merged.state, 'bounded');
  assert.match(merged.name, /^first_arg0_[0-9a-f]{4}$/);
  assert.equal(classOf(bounded, 'second|q').state, 'bounded');
  assert.match(classOf(bounded, 'second|q').name, /^first_arg0_f18_[0-9a-f]{4}$/);
  assert.equal(classOf(complete, 'first|a0').name, 'first_arg0');
  // A different merged layout under a bounded exploration never reuses the name.
  const other = solve(
    [object('first|a0', 'first', [word(0n), word(4n)], [{ anchor: argument('first'), own: true }])],
    ['argument:first:0'],
  );
  assert.notEqual(classOf(other, 'first|a0').name, merged.name);
  // A missing callee body leaves the use bounded too.
  assert.equal(classOf(solve(shared, [], ['second']), 'caller|p').state, 'bounded');
});
