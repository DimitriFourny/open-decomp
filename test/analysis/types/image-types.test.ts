import assert from 'node:assert/strict';
import test from 'node:test';
import { AnalysisBudget } from '../../../src/analysis/ssa/budget.js';
import { renderImageTypeDeclarations } from '../../../src/emitters/image-types.js';
import {
  imageTypeLabels,
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
  object(
    'caller|p',
    'caller',
    [],
    [
      { anchor: argument('first'), own: false },
      { anchor: argument('second'), own: false },
    ],
  ),
  object('first|a0', 'first', [word(0n)], [{ anchor: argument('first'), own: true }]),
  object(
    'second|a0',
    'second',
    [word(8n, 64), word(16n)],
    [{ anchor: argument('second'), own: true }],
  ),
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
  // The printed identifier is a digest of the class, never another function's anchor.
  assert.match(first.label, /^struct_[0-9a-f]{6}$/);
  assert.equal(first.label, imageTypeLabels([first.name]).get(first.name));
  assert.equal(first.state, 'complete');
  assert.deepEqual(first.functions, ['caller', 'first', 'second']);
  // The stable binding key: the callees' own roles, not the caller's uses of them.
  assert.deepEqual(first.anchors, ['argument:first:0', 'argument:second:0']);
  // Input order never changes the identity or the name.
  const reversed = solve([...shared].reverse());
  assert.equal(classOf(reversed, 'second|a0').id, first.id);
  assert.equal(classOf(reversed, 'second|a0').name, first.name);
  assert.equal(classOf(reversed, 'second|a0').label, first.label);
  assert.deepEqual(classOf(reversed, 'second|a0').anchors, first.anchors);
});

test('class labels are digests of the class name, unique within a solution', () => {
  // `image_type_890` and `image_type_5047` (any two names) share their first six digest digits.
  const labels = imageTypeLabels(['image_type_5047', 'image_type_890', 'image_type_5047']);
  assert.equal(labels.size, 2);
  const [short, extended] = ['image_type_5047', 'image_type_890'].map((id) => labels.get(id)!);
  assert.match(short!, /^struct_[0-9a-f]{6}$/);
  assert.match(extended!, /^struct_[0-9a-f]{8}$/);
  assert.ok(extended!.startsWith(short!));
  // The first ID in order keeps the short form whatever the input order.
  assert.deepEqual(imageTypeLabels(['image_type_890', 'image_type_5047']), labels);
  // A class alone keeps the short digest: the two share it.
  assert.equal(imageTypeLabels(['image_type_890']).get('image_type_890'), short);
});

test('overlapping incompatible views stay separate and record the conflict', () => {
  const solution = solve([
    object(
      'caller|p',
      'caller',
      [],
      [
        { anchor: argument('first'), own: false },
        { anchor: argument('second'), own: false },
      ],
    ),
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

const floating = (offset: bigint, width_bits = 64): ImageTypeField => ({
  ...word(offset, width_bits),
  kind: 'float',
});
const flowing = (...fields: readonly (readonly ImageTypeField[])[]): ImageTypeObject[] => [
  object(
    'caller|p',
    'caller',
    [],
    [
      { anchor: argument('first'), own: false },
      { anchor: argument('second'), own: false },
    ],
  ),
  object('first|a0', 'first', fields[0]!, [{ anchor: argument('first'), own: true }]),
  object('second|a0', 'second', fields[1]!, [{ anchor: argument('second'), own: true }]),
];

test('a float and an integer view of identical bytes merge into two members of one union', () => {
  const solution = solve(flowing([word(16n, 64)], [floating(16n)]));
  const merged = classOf(solution, 'first|a0');
  assert.equal(merged, classOf(solution, 'second|a0'));
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(
    merged.fields.map((field) => [field.offset, field.width_bits, field.kind]),
    [
      [16n, 64, 'integer'],
      [16n, 64, 'float'],
    ],
  );
  // A union already in one view joins either member's view.
  const triple = solve([
    ...flowing([word(16n, 64), floating(16n)], [floating(16n)]),
    object('third|a0', 'second', [word(16n, 64)], [{ anchor: argument('second'), own: true }]),
  ]);
  assert.equal(classOf(triple, 'first|a0').fields.length, 2);
  assert.equal(classOf(triple, 'first|a0'), classOf(triple, 'third|a0'));
  // Input order never changes the layout.
  const reversed = solve(flowing([floating(16n)], [word(16n, 64)]));
  assert.deepEqual(classOf(reversed, 'first|a0').fields, merged.fields);
});

test('a float view overlapping integer bytes of another width or offset still conflicts', () => {
  for (const [integer, float] of [
    [word(16n, 64), floating(16n, 32)],
    [word(16n, 64), floating(20n, 32)],
    [word(20n, 32), floating(16n, 64)],
  ] as const) {
    const solution = solve(flowing([integer], [float]));
    const wide = classOf(solution, 'first|a0'),
      other = classOf(solution, 'second|a0');
    assert.notEqual(wide.id, other.id);
    assert.deepEqual(wide.conflicts, [other.id]);
  }
});

test('image-wide declarations print the float and integer views as one anonymous union', () => {
  const solution = solve(flowing([word(0n, 64), word(16n, 64)], [floating(16n)]));
  const text = renderImageTypeDeclarations(solution.classes, (id) => id);
  assert.match(
    text,
    /struct \w+ \{[^}]*uint64_t field_0x0;[^}]*union \{ uint64_t field_0x10; double field_0x10_f; \};[^}]*\};/,
    text,
  );
});

test('image-wide declarations name types by label and keep the anchor as a comment', () => {
  const solution = solve([
    object(
      'caller|p',
      'caller',
      [],
      [
        { anchor: argument('first'), own: false },
        { anchor: argument('second'), own: false },
      ],
    ),
    object(
      'first|a0',
      'first',
      [word(0n, 64), word(16n)],
      [{ anchor: argument('first'), own: true }],
    ),
    object(
      'second|a0',
      'second',
      [word(4n), word(24n)],
      [{ anchor: argument('second'), own: true }],
    ),
  ]);
  const wide = classOf(solution, 'first|a0'),
    high = classOf(solution, 'second|a0');
  assert.notEqual(wide.label, high.label);
  const text = renderImageTypeDeclarations(solution.classes, (id) => id);
  for (const item of [wide, high]) {
    assert.match(text, new RegExp(`^typedef struct ${item.label} ${item.label};$`, 'm'), text);
    assert.match(
      text,
      new RegExp(`/\\* first seen: ${item.name};[^\n]*\\*/\\nstruct ${item.label} \\{`),
      text,
    );
  }
  // Conflicts print the other class's label too.
  assert.match(text, new RegExp(`conflicts with ${high.label} \\*/\\nstruct ${wide.label} `));
  assert.doesNotMatch(text, /\bfirst_arg0\b[^;]*\bstruct\b|struct first_arg0|struct second_arg0/);
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
    object(
      'first|a0',
      'first',
      [{ ...word(0x20n, 64), kind: 'pointer' }],
      [{ anchor: argument('first'), own: true }],
      [{ offset: 0x20n, stride: null, object: 'first|q' }],
    ),
    object('first|q', 'first', [word(0n)], []),
    object(
      'caller|p',
      'caller',
      [{ ...word(0x20n, 64), kind: 'pointer' }],
      [{ anchor: argument('first'), own: false }],
      [{ offset: 0x20n, stride: null, object: 'caller|q' }],
    ),
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
    object(
      'second|a0',
      'second',
      [word(8n, 64), { ...word(0x18n, 64), kind: 'pointer' }],
      [{ anchor: argument('second'), own: true }],
      [{ offset: 0x18n, stride: null, object: 'second|q' }],
    ),
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
