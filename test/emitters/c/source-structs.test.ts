import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  createOperationContext,
  expandEmission,
  type RecoveredType,
} from '../../../src/core/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import {
  recoverTypes,
  type ImageTypeBinding,
  type MemoryShape,
  type SuppliedTypeRecord,
} from '../../../src/analysis/types/index.js';
import { LocalValidationSession } from '../../../src/reconstruction/local-validation.js';
import { SourceStructs } from '../../../src/emitters/source-structs.js';
import { integer, type SSAForm } from '../../../src/ir/index.js';
import { builder, image, register, slice } from '../../ir/support.js';
import { emit, emittedFormals, execute } from './support.js';

function planner(
  definitions: Record<string, RecoveredType>,
  exhausted = false,
  shapes: readonly MemoryShape[] = [],
  images: ReadonlyMap<string, ImageTypeBinding> = new Map(),
) {
  const context = createOperationContext();
  const records = new Map<string, SuppliedTypeRecord>(
    Object.entries(definitions).map(([id, definition]) => [
      id,
      { id, definition, source: 'analysis', status: 'candidate', evidence_ids: [] },
    ]),
  );
  const validation = new LocalValidationSession(context);
  if (exhausted)
    for (let index = 0; index < 256; index++)
      validation.presentation('fixture', String(index), `capacity ${index}`);
  return new SourceStructs(records, validation, 'function', context, shapes, images);
}
const word: RecoveredType = { kind: 'integer', bits: 32, signed: false };
function shape(fields: readonly [bigint, string][]): RecoveredType {
  return {
    kind: 'structure',
    size: null,
    alignment: null,
    fields: fields.map(([offset, type_id], index) => ({
      id: `field-${index}`,
      name: `field-${index}`,
      offset,
      type_id,
    })),
  };
}

test('observed structure names unify equal layouts and separate different ones', () => {
  const structs = planner({
    word,
    otherWord: word,
    first: shape([
      [4n, 'word'],
      [24n, 'word'],
    ]),
    second: shape([
      [24n, 'otherWord'],
      [4n, 'word'],
    ]),
    different: shape([[8n, 'word']]),
  });
  assert.equal(structs.name('second'), structs.name('first'));
  assert.notEqual(structs.name('different'), structs.name('first'));
  assert.match(structs.name('first'), /^struct_[0-9a-f]{6}$/);
  assert.deepEqual(
    structs.layout('first')?.map((member) => member.offset),
    [4n, 24n],
  );
});

test('image-wide names print as the binding label; layout digests never reuse one', () => {
  const definitions = { word, first: shape([[4n, 'word']]), second: shape([[8n, 'word']]) };
  const plain = planner(definitions).name('first');
  assert.match(plain, /^struct_[0-9a-f]{6}$/);
  const binding = (name: string): ImageTypeBinding => ({
    type_id: 'second',
    name,
    first_seen: 'setSectorSize_arg0',
    state: 'complete',
    functions: 2,
    conflicts: [],
  });
  // The binding's label names its type, whatever its anchor says.
  const labelled = planner(definitions, false, [], new Map([['second', binding('struct_123abc')]]));
  assert.equal(labelled.name('second'), 'struct_123abc');
  assert.doesNotMatch(labelled.name('second'), /setSectorSize/);
  assert.equal(labelled.name('first'), plain);
  // Another type's digest that equals a reserved label extends until unique.
  const reserved = planner(definitions, false, [], new Map([['second', binding(plain)]]));
  assert.equal(reserved.name('second'), plain);
  const other = reserved.name('first');
  assert.notEqual(other, plain);
  assert.match(other, /^struct_[0-9a-f]{8}$/);
  assert.ok(other.startsWith(plain));
  assert.equal(reserved.name('first'), other);
});

test('single scalar, floating, pointer and proven-stride array pointees collapse without bounds', () => {
  const structs = planner({
    word,
    floating: { kind: 'float', bits: 64 },
    pointer: { kind: 'pointer', bits: 64, to: 'word' },
    array: { kind: 'array', element: 'word', count: null },
    scalarShape: shape([[0n, 'word']]),
    floatShape: shape([[0n, 'floating']]),
    pointerShape: shape([[0n, 'pointer']]),
    arrayShape: shape([[0n, 'array']]),
    offsetShape: shape([[4n, 'word']]),
  });
  for (const [id, type] of [
    ['scalarShape', 'word'],
    ['floatShape', 'floating'],
    ['pointerShape', 'pointer'],
    ['arrayShape', 'word'],
  ])
    assert.equal(structs.scalar(id!), type);
  assert.equal(structs.scalar('offsetShape'), null);
});

test('contiguous same-type members collapse to a scalar array pointee; struct evidence keeps the structure', () => {
  const byte: RecoveredType = { kind: 'integer', bits: 8, signed: false },
    sbyte: RecoveredType = { kind: 'integer', bits: 8, signed: true };
  const definitions: Record<string, RecoveredType> = {
    word,
    sameWord: word,
    byte,
    sbyte,
    floating: { kind: 'float', bits: 32 },
    pointer: { kind: 'pointer', bits: 64, to: 'word' },
    array: { kind: 'array', element: 'word', count: null },
    fixed: { kind: 'array', element: 'word', count: 4n },
    unrolled: shape([
      [0n, 'word'],
      [4n, 'sameWord'],
      [8n, 'word'],
      [12n, 'word'],
    ]),
    shifted: shape([
      [4n, 'word'],
      [8n, 'word'],
    ]),
    bytes: shape([
      [0n, 'byte'],
      [1n, 'byte'],
      [2n, 'byte'],
    ]),
    floats: shape([
      [0n, 'floating'],
      [4n, 'floating'],
    ]),
    indexed: shape([
      [0n, 'word'],
      [4n, 'array'],
    ]),
    mixedWidth: shape([
      [0n, 'byte'],
      [1n, 'word'],
    ]),
    mixedKind: shape([
      [0n, 'word'],
      [4n, 'floating'],
    ]),
    mixedSign: shape([
      [0n, 'byte'],
      [1n, 'sbyte'],
    ]),
    gap: shape([
      [0n, 'word'],
      [8n, 'word'],
    ]),
    misaligned: shape([
      [0n, 'word'],
      [2n, 'word'],
    ]),
    pointers: shape([
      [0n, 'pointer'],
      [8n, 'pointer'],
    ]),
    counted: shape([
      [0n, 'word'],
      [4n, 'fixed'],
    ]),
    sized: { ...(shape([[0n, 'word']]) as object), size: 8n } as RecoveredType,
    sizedPair: {
      ...(shape([
        [0n, 'word'],
        [4n, 'word'],
      ]) as object),
      size: 16n,
    } as RecoveredType,
  };
  const structs = planner(definitions);
  for (const [id, type] of [
    ['unrolled', 'word'],
    ['shifted', 'word'],
    ['bytes', 'byte'],
    ['floats', 'floating'],
    ['indexed', 'word'],
  ])
    assert.equal(structs.scalar(id!), type, id);
  for (const id of [
    'mixedWidth',
    'mixedKind',
    'mixedSign',
    'gap',
    'misaligned',
    'pointers',
    'counted',
    'sized',
    'sizedPair',
  ])
    assert.equal(structs.scalar(id), null, id);
  assert.equal(structs.layout('unrolled'), null);
  assert.ok(structs.layout('mixedWidth'));
  assert.ok(structs.layout('gap'));
  assert.match(structs.name('mixedWidth'), /^struct_[0-9a-f]{6}$/);

  // A proven record period is struct evidence.
  const periodic = planner(
    {
      word,
      pair: shape([
        [0n, 'word'],
        [4n, 'word'],
      ]),
    },
    false,
    [
      {
        id: 'shape',
        type_id: 'pair',
        base: { kind: 'value', value_id: 'base' },
        base_offset: 0n,
        observed_extent: null,
        fields: [0n, 4n].map((offset, index) => ({
          id: `observed-${index}`,
          offset,
          width_bits: 32,
          node_ids: [],
          value_ids: [],
          evidence_ids: [],
          access: ['read' as const],
          stack_region: null,
          stride: 16n,
        })),
        alias: 'possible',
        escape: 'unknown',
        dynamic: true,
        evidence_ids: [],
      },
    ],
  );
  assert.equal(periodic.scalar('pair'), null);
  assert.ok(periodic.layout('pair'));
});

test('scalar-array collapse records its presentation rule and refuses when capacity is exhausted', () => {
  const records = {
    word,
    pair: shape([
      [0n, 'word'],
      [4n, 'word'],
    ]),
  };
  assert.equal(planner(records).scalar('pair'), 'word');
  assert.equal(planner(records, true).scalar('pair'), null);
});

test('array members retain proven strides and unknown counts; ambiguous overlap stays explicit', () => {
  const structs = planner({
    word,
    array: { kind: 'array', element: 'word', count: null },
    valid: shape([
      [0n, 'word'],
      [8n, 'array'],
    ]),
    overlap: shape([
      [0n, 'word'],
      [2n, 'word'],
    ]),
    nonfinal: shape([
      [8n, 'array'],
      [16n, 'word'],
    ]),
  });
  assert.equal(structs.layout('valid')?.[1]?.count, null);
  assert.equal(structs.layout('overlap'), null);
  assert.equal(structs.layout('nonfinal'), null);
});

test('recursive pointer shapes remain named and identical recursive views unify', () => {
  const structs = planner({
    first: shape([[0n, 'firstPointer']]),
    firstPointer: { kind: 'pointer', bits: 64, to: 'first' },
    second: shape([[0n, 'secondPointer']]),
    secondPointer: { kind: 'pointer', bits: 64, to: 'second' },
  });
  assert.equal(structs.scalar('first'), null);
  assert.equal(structs.name('first'), structs.name('second'));
  assert.equal(structs.layout('first')?.[0]?.typeId, 'firstPointer');
});

test('exhausted presentation capacity retains opaque structures and scalar wrappers', () => {
  const structs = planner(
    { word, record: shape([[4n, 'word']]), scalar: shape([[0n, 'word']]) },
    true,
  );
  assert.equal(structs.layout('record'), null);
  assert.equal(structs.scalar('scalar'), null);
});

test('external structures leave typedefs and bodies out of the text and return them once', () => {
  const b = builder('source-external-struct'),
    block = b.block('entry');
  const pointer = block.readRegister(register('rdi', 64, 0, 'replace_root', 'x86_64:rdi'));
  const first = block.cast(
    'zero_extend',
    integer(32),
    block.load(integer(8), block.int('add', pointer, block.constant(integer(64), 4n))),
  );
  const second = block.load(
    integer(32),
    block.int('add', pointer, block.constant(integer(64), 24n)),
  );
  block.return([block.int('add', first, second)]);
  const ssa = constructSSA(b.finish(block, [integer(32)])).value as SSAForm;
  const types = recoverTypes(ssa, sysvAMD64Abi, createOperationContext(), {
    slice_id: slice,
    image_id: image,
    revision: 1,
  });
  const extra = { types, source: { abi: sysvAMD64Abi, callees: [], addresses: [] } };
  const inline = emit(ssa, extra).emission;
  const external = emit(ssa, extra, 'c-like', 'source', { structures: 'external' }).emission;
  assert.equal(inline.structures, undefined);
  const name = /^typedef struct (\w+) \1;$/m.exec(inline.text)?.[1];
  assert.ok(name);
  assert.match(inline.text, new RegExp(`^struct ${name} \\{`, 'm'));
  // The text keeps its statements and names the structure; the declarations moved.
  assert.doesNotMatch(external.text, /^typedef struct |^struct \w+ \{/m);
  assert.match(external.text, /^\/\* struct declarations: types\.h \*\/$/m);
  assert.match(external.text, new RegExp(`${name}\\* `));
  const declarations = external.structures ?? [];
  assert.deepEqual(
    declarations.map((item) => item.name),
    [name, name],
  );
  assert.equal(declarations[0]!.declaration, `typedef struct ${name} ${name};`);
  // The declarations are exactly the lines the inline text carries.
  for (const line of declarations[1]!.declaration.split('\n'))
    assert.ok(inline.text.includes(line), line);
  assert.match(declarations[1]!.declaration, /uint8_t field_0x4;/);
  // Python-like has no structure preamble: the option changes nothing there.
  assert.equal(
    emit(ssa, extra, 'python-like', 'source', { structures: 'external' }).emission.structures,
    undefined,
  );
});

for (const indexed of [false, true, 'shared', 'array'] as const)
  test(`observed ${indexed === false ? 'fixed' : indexed === true ? 'strided' : indexed} members compile and execute with exact offsets and ordered loads`, () => {
    const b = builder('source-observed-struct'),
      block = b.block('entry');
    const pointer = block.readRegister(register('rdi', 64, 0, 'replace_root', 'x86_64:rdi'));
    const index = indexed
      ? block.readRegister(register('rsi', 64, 0, 'replace_root', 'x86_64:rsi'))
      : null;
    const address =
      index && indexed !== 'array'
        ? block.int('add', pointer, block.int('mul', index, block.constant(integer(64), 32n)))
        : pointer;
    const first = block.cast(
      'zero_extend',
      integer(32),
      block.load(integer(8), block.int('add', address, block.constant(integer(64), 4n))),
    );
    const secondAddress =
      indexed === 'shared'
        ? address
        : index
          ? block.int(
              'add',
              pointer,
              block.int('mul', index, block.constant(integer(64), indexed === 'array' ? 4n : 32n)),
            )
          : pointer;
    const second = block.load(
      integer(32),
      block.int('add', secondAddress, block.constant(integer(64), 24n)),
    );
    block.return([block.int('add', first, second)]);
    const ssa = constructSSA(b.finish(block, [integer(32)])).value as SSAForm;
    const types = recoverTypes(ssa, sysvAMD64Abi, createOperationContext(), {
      slice_id: slice,
      image_id: image,
      revision: 1,
    });
    const output = emit(ssa, { types, source: { abi: sysvAMD64Abi, callees: [], addresses: [] } });
    assert.match(output.emission.text, /\/\* partial\b[^*]*\*\/\nstruct /);
    assert.match(output.emission.text, /uint8_t field_0x4;/);
    assert.match(output.emission.text, /uint32_t field_0x18(?:\[\])?;/);
    assert.match(output.emission.text, indexed === true ? /\]\.field_0x18/ : /->field_0x18/);
    if (indexed === 'array') assert.match(output.emission.text, /->field_0x18\[/);
    const compiled = spawnSync(
      'clang',
      ['-x', 'c', '-fsyntax-only', '-std=c11', '-include', 'stdint.h', '-include', 'stddef.h', '-'],
      { input: output.emission.text, encoding: 'utf8' },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    const id = ssa.register_states
      .find((state) => state.block === ssa.entry)!
      .entry.find((binding) => binding.register.root === 'x86_64:rdi')!.value.id;
    const mapping = expandEmission(output.emission).mappings.find((item) =>
      item.semantic_ids.includes(id),
    )!;
    const memory = new Map<bigint, number>();
    for (const [offset, value] of [
      [4n, 17],
      [24n, 25],
    ] as const)
      for (let byte = 0; byte < 4; byte++)
        memory.set(0x1000n + offset + BigInt(byte), byte === 0 ? value : 0);
    const inputs = new Map(mapping.semantic_ids.map((subject) => [subject, 0x1000n]));
    if (index) {
      const indexId = ssa.register_states
        .find((state) => state.block === ssa.entry)!
        .entry.find((binding) => binding.register.root === 'x86_64:rsi')!.value.id;
      const indexMapping = expandEmission(output.emission).mappings.find((item) =>
        item.semantic_ids.includes(indexId),
      )!;
      for (const subject of indexMapping.semantic_ids) inputs.set(subject, 2n);
    }
    if (index) {
      const shifted = [...memory].map(
        ([address, byte]) =>
          [address + (indexed === 'array' ? (address >= 0x1018n ? 8n : 0n) : 64n), byte] as const,
      );
      memory.clear();
      for (const [address, byte] of shifted) memory.set(address, byte);
    }
    const observed = execute(output.emission, inputs, memory);
    assert.deepEqual(observed.values, [42n]);
    assert.deepEqual(observed.events, ['load', 'load']);
    memory.delete([...memory.keys()].at(-1)!);
    assert.equal(execute(output.emission, inputs, memory).exit, 'fault');
  });

test('a bodyless structure typedef appears once, before the text that uses it', () => {
  const b = builder('source-bodyless-struct'),
    block = b.block('entry');
  const pointer = block.readRegister(register('rdi', 64, 0, 'replace_root', 'x86_64:rdi'));
  const first = block.load(
    integer(32),
    block.int('add', pointer, block.constant(integer(64), 0x20000n)),
  );
  const second = block.cast(
    'zero_extend',
    integer(32),
    block.load(integer(8), block.int('add', pointer, block.constant(integer(64), 0x20004n))),
  );
  block.return([block.int('add', first, second)]);
  const ssa = constructSSA(b.finish(block, [integer(32)])).value as SSAForm;
  const types = recoverTypes(ssa, sysvAMD64Abi, createOperationContext(), {
    slice_id: slice,
    image_id: image,
    revision: 1,
  });
  const text = emit(ssa, { types, source: { abi: sysvAMD64Abi, callees: [], addresses: [] } })
    .emission.text;
  const name = /^typedef struct (struct_[0-9a-f]{6}) \1;$/m.exec(text)?.[1];
  assert.ok(name, text);
  assert.equal(text.match(new RegExp(`^typedef struct ${name} ${name};$`, 'gm'))?.length, 1);
  assert.doesNotMatch(text, new RegExp(`^struct ${name} \\{`, 'm'));
  assert.ok(text.indexOf(`typedef struct ${name}`) < text.indexOf(`${name}* `));
  const compiled = spawnSync(
    'clang',
    ['-x', 'c', '-fsyntax-only', '-std=c11', '-include', 'stdint.h', '-include', 'stddef.h', '-'],
    { input: text, encoding: 'utf8' },
  );
  assert.equal(compiled.status, 0, compiled.stderr);
});

for (const mixed of [false, true])
  test(`unrolled ${mixed ? 'mixed-width' : 'same-width'} accesses print ${mixed ? 'a structure' : 'a scalar array with subscripts'}`, () => {
    const b = builder('source-unrolled-array'),
      block = b.block('entry');
    const pointer = block.readRegister(register('rdi', 64, 0, 'replace_root', 'x86_64:rdi'));
    const first = block.load(integer(32), pointer);
    const second = block.load(
      integer(32),
      block.int('add', pointer, block.constant(integer(64), 4n)),
    );
    const thirdAddress = block.int('add', pointer, block.constant(integer(64), 8n));
    const third = mixed
      ? block.cast('zero_extend', integer(32), block.load(integer(8), thirdAddress))
      : block.load(integer(32), thirdAddress);
    block.return([block.int('add', block.int('add', first, second), third)]);
    const ssa = constructSSA(b.finish(block, [integer(32)])).value as SSAForm;
    const types = recoverTypes(ssa, sysvAMD64Abi, createOperationContext(), {
      slice_id: slice,
      image_id: image,
      revision: 1,
    });
    const output = emit(ssa, { types, source: { abi: sysvAMD64Abi, callees: [], addresses: [] } });
    const text = output.emission.text;
    if (mixed) {
      assert.match(text, /\/\* partial\b[^*]*\*\/\nstruct /);
      assert.match(text, /->field_0x8/);
    } else {
      assert.doesNotMatch(text, /struct_[0-9a-f]+|->field_0x/);
      assert.match(text, /uint32_t\* \w+\)/);
      assert.match(text, /\[1\]/);
      assert.match(text, /\[2\]/);
    }
    const compiled = spawnSync(
      'clang',
      ['-x', 'c', '-fsyntax-only', '-std=c11', '-include', 'stdint.h', '-include', 'stddef.h', '-'],
      { input: text, encoding: 'utf8' },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    if (!mixed) {
      const id = ssa.register_states
        .find((state) => state.block === ssa.entry)!
        .entry.find((binding) => binding.register.root === 'x86_64:rdi')!.value.id;
      const mapping = expandEmission(output.emission).mappings.find((item) =>
        item.semantic_ids.includes(id),
      )!;
      const memory = new Map<bigint, number>();
      for (const [offset, value] of [
        [0n, 1],
        [4n, 2],
        [8n, 3],
      ] as const)
        for (let byte = 0; byte < 4; byte++)
          memory.set(0x1000n + offset + BigInt(byte), byte === 0 ? value : 0);
      const inputs = new Map(mapping.semantic_ids.map((subject) => [subject, 0x1000n]));
      const observed = execute(output.emission, inputs, memory);
      assert.deepEqual(observed.values, [6n]);
      assert.deepEqual(observed.events, ['load', 'load', 'load']);
    }
  });

test('unknown pointer targets receive valid opaque declarations without an invented layout', () => {
  const b = builder('opaque-source-pointee'),
    block = b.block('entry');
  const pointer = block.readRegister(register('rdi', 64, 0, 'replace_root', 'x86_64:rdi'));
  block.return([block.load(integer(32), pointer)]);
  const ssa = constructSSA(b.finish(block, [integer(32)])).value as SSAForm;
  const binding = ssa.register_states
    .find((state) => state.block === ssa.entry)!
    .entry.find((item) => item.register.root === 'x86_64:rdi')!;
  const types = recoverTypes(ssa, sysvAMD64Abi, createOperationContext(), {
    slice_id: slice,
    image_id: image,
    revision: 1,
    types: [
      {
        id: 'opaque',
        definition: { kind: 'unknown', size: null },
        source: 'debug',
        status: 'established',
        evidence_ids: [],
      },
      {
        id: 'pointer',
        definition: { kind: 'pointer', bits: 64, to: 'opaque' },
        source: 'debug',
        status: 'established',
        evidence_ids: [],
      },
    ],
    bindings: [
      {
        subject_id: binding.value.id,
        type_id: 'pointer',
        source: 'debug',
        status: 'established',
        evidence_ids: [],
      },
    ],
  });
  const output = emit(ssa, { types, source: { abi: sysvAMD64Abi, callees: [], addresses: [] } });
  assert.match(output.emission.text, /typedef struct opaque_1 opaque_1;/);
  assert.match(output.emission.text, /opaque_1\*/);
  assert.doesNotMatch(output.emission.text, /struct opaque_1\s*\{/);
  const compiled = spawnSync(
    'clang',
    ['-x', 'c', '-fsyntax-only', '-std=c11', '-include', 'stdint.h', '-include', 'stddef.h', '-'],
    { input: output.emission.text, encoding: 'utf8' },
  );
  assert.equal(compiled.status, 0, compiled.stderr);
});

test('members accessed through a derived address read only by accesses print through the base', () => {
  const b = builder('source-derived-members'),
    block = b.block('entry');
  const pointer = block.readRegister(register('rdi', 64, 0, 'replace_root', 'x86_64:rdi'));
  const derived = block.int('add', pointer, block.constant(integer(64), 0x20n));
  block.store(derived, block.constant(integer(8), 7n));
  block.store(
    block.int('add', derived, block.constant(integer(64), 8n)),
    block.cast(
      'truncate',
      integer(32),
      block.readRegister(register('rsi', 64, 0, 'replace_root', 'x86_64:rsi')),
    ),
  );
  const field = block.load(integer(16), block.int('add', derived, block.constant(integer(64), 4n)));
  block.return([block.cast('zero_extend', integer(32), field)]);
  const ssa = constructSSA(b.finish(block, [integer(32)])).value as SSAForm;
  const types = recoverTypes(ssa, sysvAMD64Abi, createOperationContext(), {
    slice_id: slice,
    image_id: image,
    revision: 1,
  });
  const render = (language: 'c-like' | 'python-like', view: 'source' | 'checked' = 'source') =>
    emit(ssa, { types, source: { abi: sysvAMD64Abi, callees: [], addresses: [] } }, language, view)
      .emission;
  const text = render('c-like').text;
  assert.match(text, /(\w+)->field_0x20 = 7;\n\s*\1->field_0x28 = \w+;\n.*\1->field_0x24\b/, text);
  assert.doesNotMatch(text, /\+ 0x20\b|uintptr_t/, text);
  const compiled = spawnSync(
    'clang',
    ['-x', 'c', '-fsyntax-only', '-std=c11', '-include', 'stdint.h', '-include', 'stddef.h', '-'],
    { input: text, encoding: 'utf8' },
  );
  assert.equal(compiled.status, 0, compiled.stderr);
  const bytes = new Map(
    Array.from({ length: 0x40 }, (_, offset) => [0x1000n + BigInt(offset), offset] as const),
  );
  for (const language of ['c-like', 'python-like'] as const) {
    const run = (view: 'source' | 'checked', memory: Map<bigint, number>) => {
      const emission = render(language, view),
        formals = emittedFormals(emission);
      return execute(
        emission,
        new Map([
          ...formals[0]!.semantic_ids.map((id) => [id, 0x1000n] as const),
          ...formals[1]!.semantic_ids.map((id) => [id, 0xa1b2c3d4e5n] as const),
        ]),
        memory,
      );
    };
    const observed = run('source', new Map(bytes));
    assert.deepEqual(observed.values, [0x2524n]);
    assert.deepEqual(observed.events, ['store', 'store', 'load']);
    assert.equal(observed.memory.get(0x1020n), 7);
    assert.deepEqual(
      [0x28n, 0x29n, 0x2an, 0x2bn].map((offset) => observed.memory.get(0x1000n + offset)),
      [0xe5, 0xd4, 0xc3, 0xb2],
    );
    const faulting = new Map(bytes);
    faulting.delete(0x102bn);
    const fault = run('source', new Map(faulting)),
      checked = run('checked', new Map(faulting));
    assert.equal(fault.exit, 'fault');
    assert.deepEqual(fault.events, checked.events);
    assert.deepEqual(fault.memory, checked.memory);
  }
});
