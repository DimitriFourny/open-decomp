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
import { recoverTypes, type SuppliedTypeRecord } from '../../../src/analysis/types/index.js';
import { LocalValidationSession } from '../../../src/reconstruction/local-validation.js';
import { SourceStructs } from '../../../src/emitters/source-structs.js';
import { integer, type SSAForm } from '../../../src/ir/index.js';
import { builder, image, register, slice } from '../../ir/support.js';
import { emit, execute } from './support.js';

function planner(definitions: Record<string, RecoveredType>, exhausted = false) {
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
  return new SourceStructs(records, validation, 'function', context);
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

test('observed structure names unify equal layouts without field names or hashes', () => {
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
  assert.equal(structs.name('first'), 'struct_1');
  assert.equal(structs.name('second'), 'struct_1');
  assert.equal(structs.name('different'), 'struct_2');
  assert.deepEqual(
    structs.layout('first')?.map((member) => member.offset),
    [4n, 24n],
  );
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
    assert.match(output.emission.text, /observed members only; size unknown/);
    assert.match(output.emission.text, /uint8_t f_4;/);
    assert.match(output.emission.text, /uint32_t f_18(?:\[\])?;/);
    assert.match(output.emission.text, indexed === true ? /\]\.f_18/ : /->f_18/);
    if (indexed === 'array') assert.match(output.emission.text, /->f_18\[/);
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
