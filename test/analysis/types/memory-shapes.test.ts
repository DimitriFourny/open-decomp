import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext } from '../../../src/core/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { recoverTypes, refineMemoryShapes, parameterMemoryShapes, type MemoryShapeTransfer, type TypeRecoveryResult } from '../../../src/analysis/types/index.js';
import { integer, type SSAForm, type Value } from '../../../src/ir/index.js';
import { builder, image, register, slice } from '../../ir/support.js';
import { emit, emittedFormals, execute } from '../../emitters/c/support.js';

const i64 = integer(64);
const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
const options = { slice_id: slice, image_id: image, revision: 7 };
interface ShapeFixture {
  readonly ssa: SSAForm;
  readonly pointer: Value;
  readonly types: TypeRecoveryResult;
}
function fixture(name: string, offset: bigint, width = 32, stride: bigint | null = null) {
  const b = builder(name), block = b.block('entry');
  const base = block.readRegister(rdi);
  let address = block.int('add', base, block.constant(i64, offset));
  if (stride !== null) {
    const index = block.readRegister(register('rsi', 64, 0, 'replace_root', 'x86_64:rsi'));
    address = block.int('add', address, block.int('mul', index, block.constant(i64, stride)));
  }
  block.return([block.load(integer(width), address)]);
  const ssa = constructSSA(b.finish(block, [integer(width)])).value as SSAForm;
  const pointer = ssa.register_states.find((state) => state.block === ssa.entry)!.entry
    .find((binding) => binding.register.root === rdi.root)!.value;
  return { ssa, pointer, types: recoverTypes(ssa, sysvAMD64Abi, createOperationContext(), options) };
}
function transfer(callee: ShapeFixture, argument: Value, call_id: string): MemoryShapeTransfer {
  return { parameter_index: 0, parameter_shape: callee.types.shapes.find((shape) => shape.base.kind === 'value')!,
    types: callee.types.types, associations: callee.types.associations, evidence: callee.types.evidence,
    argument, call_id, evidence_ids: [] };
}

test('compatible callee partial layouts accumulate without caller reanalysis or invented size', () => {
  const caller = fixture('shape-caller', 0n), first = fixture('shape-first', 8n), second = fixture('shape-second', 24n, 32, 4n);
  const result = refineMemoryShapes(caller.ssa, caller.types, createOperationContext(), {
    ...options, transfers: [transfer(first, caller.pointer, 'call-first'), transfer(second, caller.pointer, 'call-second')],
  });
  assert.equal(result.state, 'complete');
  assert.equal(result.calls, caller.types.calls, 'reuse existing physical/stack analysis');
  const shape = result.shapes.find((item) => item.base.kind === 'value' && item.base.value_id === caller.pointer.id)!;
  assert.deepEqual(shape.fields.map((field) => [field.offset, field.stride]), [[0n, null], [8n, null], [24n, 4n]]);
  assert.deepEqual(shape.observed_extent, { start: 0n, end: 12n });
  assert.equal(shape.escape, 'observed');
  assert.equal(shape.alias, 'possible');
  const definition = result.types.find((record) => record.id === shape.type_id)!.definition;
  assert.equal(definition.kind, 'structure');
  if (definition.kind === 'structure') {
    assert.equal(definition.size, null);
    assert.equal(definition.alignment, null);
    assert.equal(definition.fields.length, 3);
    assert.ok(result.types.some((record) => record.id === definition.fields[2]!.type_id &&
      record.definition.kind === 'array' && record.definition.count === null));
  }
  const imported = shape.fields.find((field) => field.offset === 8n)!;
  assert.ok(imported.node_ids.includes(first.types.shapes[0]!.fields[0]!.node_ids[0]!));
  assert.ok(result.evidence.some((proof) => imported.evidence_ids.includes(proof.id) &&
    proof.claim === 'callee memory access through caller argument' && proof.revision === options.revision));
  const repeated = refineMemoryShapes(caller.ssa, result, createOperationContext(), {
    ...options, transfers: [transfer(first, caller.pointer, 'call-first')],
  });
  assert.deepEqual(repeated.shapes, result.shapes, 'repeated derivation is idempotent');
});

test('overlapping layouts stay explicit alternatives and resource failure is transactional', () => {
  const caller = fixture('shape-union-caller', 0n, 64), callee = fixture('shape-union-callee', 4n);
  const transfers = [transfer(callee, caller.pointer, 'call-union')];
  const result = refineMemoryShapes(caller.ssa, caller.types, createOperationContext(), { ...options, transfers });
  assert.equal(result.shapes[0]!.fields.length, 2);
  assert.ok(result.conflicts.some((conflict) => conflict.reason === 'overlapping_accesses' &&
    conflict.alternatives.length === 2));
  const failed = refineMemoryShapes(caller.ssa, caller.types, createOperationContext(), { ...options, transfers, max_work: 0 });
  assert.equal(failed.state, 'partial');
  assert.equal(failed.shapes, caller.types.shapes);
  assert.ok(failed.diagnostics.some((diagnostic) => diagnostic.code === 'resource_limit'));
});

test('wrapped signed argument displacements retain the original base and negative partial origin', () => {
  const caller = fixture('shape-wrapped-caller', -8n), callee = fixture('shape-wrapped-callee', 0n);
  const address = caller.ssa.blocks.flatMap((block) => block.instructions)
    .find((node) => node.kind === 'load')!;
  assert.equal(address.kind, 'load');
  if (address.kind !== 'load') return;
  const result = refineMemoryShapes(caller.ssa, caller.types, createOperationContext(), {
    ...options, transfers: [transfer(callee, address.address, 'call-interior')],
  });
  const shape = result.shapes.find((item) => item.base.kind === 'value' && item.base.value_id === caller.pointer.id)!;
  assert.equal(shape.base_offset, -8n);
  assert.deepEqual(shape.observed_extent, { start: -8n, end: -4n });
  assert.equal(shape.fields.length, 1, 'compatible accesses merge by physical offset and width');
  assert.equal(result.associations.some((association) => association.subject_id === caller.pointer.id &&
    result.types.some((record) => record.id === association.type_id && record.definition.kind === 'pointer')), false,
  'negative origin does not invent a pointer to a zero-origin structure');
});

test('independent caller and callee indices retain an unknown dynamic view without inventing an extent', () => {
  const caller = fixture('shape-two-index-caller', 0n, 32, 8n);
  const callee = fixture('shape-two-index-callee', 0n, 32, 4n);
  const load = caller.ssa.blocks.flatMap((block) => block.instructions).find((node) => node.kind === 'load')!;
  assert.equal(load.kind, 'load');
  if (load.kind !== 'load') return;
  const result = refineMemoryShapes(caller.ssa, caller.types, createOperationContext(), {
    ...options, transfers: [transfer(callee, load.address, 'call-independent-index')],
  });
  const shape = result.shapes.find((item) => item.base.kind === 'value' && item.base.value_id === caller.pointer.id)!;
  assert.equal(shape.observed_extent, null);
  const field = shape.fields.find((item) => item.dynamic);
  assert.ok(field);
  assert.equal(field.stride, null);
  const type = result.types.find((record) => record.id === shape.type_id)!.definition;
  assert.equal(type.kind, 'structure');
  if (type.kind === 'structure')
    assert.equal(type.fields.some((member) => member.id === field.id), false,
      'an unknown-index view cannot become a fixed structure member');
});

test('a loaded indirect target retains callable field identity and real arguments without a guessed prototype', () => {
  const b = builder('shape-callback-field'), block = b.block('entry');
  const pointer = block.readRegister(rdi);
  const target = block.load(i64, block.int('add', pointer, block.constant(i64, 24n)));
  const argument = block.load(integer(32), pointer);
  block.return(block.call({ kind: 'indirect', value: target }, [argument], [integer(32)],
    sysvAMD64Abi.unknown_call_clobbers));
  const ssa = constructSSA(b.finish(block, [integer(32)])).value as SSAForm;
  const types = recoverTypes(ssa, sysvAMD64Abi, createOperationContext(), options);
  const call = ssa.blocks.flatMap((block) => block.instructions).find((node) => node.kind === 'call')!;
  assert.equal(call.kind, 'call');
  if (call.kind !== 'call') return;
  const field = types.shapes.flatMap((shape) => shape.fields).find((field) => field.offset === 24n)!;
  assert.deepEqual(field.call_target_ids, [call.id]);
  assert.equal(call.arguments.length, 1);
  assert.equal(call.arguments[0]!.type.kind, 'integer');
  assert.ok(types.associations.some((association) => association.subject_id === field.id &&
    types.types.some((record) => record.id === association.type_id && record.definition.kind === 'pointer')));
  assert.equal(types.signatures.some((signature) => signature.subject_id === call.id), false,
    'an observed callable address is not a supplied complete prototype');
});

test('parameter summaries retain only exact parameter-associated type closures and enforce their own bound', () => {
  const local = fixture('shape-parameter-closure', 8n);
  const recovery: TypeRecoveryResult = { ...local.types, types: [...local.types.types, {
    id: 'unrelated-record', definition: { kind: 'unknown', size: 4096n },
    source: 'debug', status: 'established', evidence_ids: [],
  }] };
  const parameters = [{ parameter_index: 7, value: local.pointer }];
  const summaries = parameterMemoryShapes(recovery, parameters, createOperationContext());
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]!.parameter_index, 7);
  assert.equal(summaries[0]!.parameter_shape, local.types.shapes[0]);
  assert.equal(summaries[0]!.types.some((record) => record.id === 'unrelated-record'), false);
  assert.ok(summaries[0]!.types.some((record) => record.id === local.types.shapes[0]!.type_id));
  assert.deepEqual(parameterMemoryShapes(recovery, [], createOperationContext()), []);
  assert.throws(() => parameterMemoryShapes(recovery, parameters, createOperationContext(), { max_work: 0 }),
    /work limit/);
});

for (const language of ['c-like', 'python-like'] as const)
  test(`${language} exact pointer fragments and phi copies retain one partial view and typed source formal`, () => {
    const b = builder(`shape-fragment-phi-${language}`);
    const entry = b.block('entry'), body = b.block('body', [i64]);
    const low = entry.readRegister(register('edi', 32, 0, 'zero_extend_root', 'x86_64:rdi'));
    const high = entry.readRegister(register('rdi.high', 32, 32, 'preserve_other_bits', 'x86_64:rdi'));
    const pointer = entry.concat([low, high]);
    entry.jump(body, [pointer]);
    const copied = body.int('or', body.parameters[0]!, body.constant(i64, 0n));
    const address = body.int('add', copied, body.constant(i64, 8n));
    const reassembled = body.concat([body.extract(address, 0, 32), body.extract(address, 32, 32)]);
    body.return([body.load(integer(32), reassembled)]);
    const ssa = constructSSA(b.finish(entry, [integer(32)])).value as SSAForm;
    const types = recoverTypes(ssa, sysvAMD64Abi, createOperationContext(), options);
    const shape = types.shapes.find((shape) => shape.base.kind === 'value')!;
    assert.equal(shape.base.kind, 'value');
    if (shape.base.kind !== 'value') return;
    assert.equal(shape.base.value_id, pointer.id);
    assert.equal(shape.fields[0]!.offset, 8n);
    const pointerType = types.types.find((record) => record.definition.kind === 'pointer' &&
      record.definition.to === shape.type_id)!;
    const fragments = types.associations.filter((association) => association.type_id === pointerType.id &&
      association.width_bits === 32);
    assert.deepEqual([...new Set(fragments.map((association) => association.value_offset_bits))].sort(), [0, 32]);
    const output = emit(ssa, { types, source: { abi: sysvAMD64Abi, callees: [], addresses: [] } }, language);
    const formals = emittedFormals(output.emission).filter((formal) => formal.name !== 'entry_sp');
    assert.equal(formals.length, 1);
    const declaration = output.emission.mappings.find((mapping) => mapping.statement_id === formals[0]!.statement_id)!;
    assert.match(output.emission.text.slice(declaration.start, declaration.end),
      language === 'c-like' ? /\*/ : /pointer\[/);
    const memory = new Map(Array.from({ length: 4 }, (_, byte) => [0x3008n + BigInt(byte), byte === 0 ? 37 : 0]));
    const observed = execute(output.emission, new Map([[formals[0]!.statement_id, 0x3000n]]), memory);
    assert.deepEqual(observed.values, [37n]);
    assert.deepEqual(observed.events, ['load']);
  });

test('different incoming pointer bases remain a phi view rather than asserting an alias to either input', () => {
  const b = builder('shape-distinct-pointer-phi');
  const entry = b.block('entry'), left = b.block('left', [i64]), right = b.block('right', [i64]);
  const join = b.block('join', [i64]);
  const p = entry.readRegister(rdi);
  const q = entry.readRegister(register('rsi', 64, 0, 'replace_root', 'x86_64:rsi'));
  entry.branch(entry.indeterminate(integer(1), 'unknown', 'condition'), entry.edge(left, [p]), entry.edge(right, [q]));
  left.jump(join, [left.parameters[0]!]);
  right.jump(join, [right.parameters[0]!]);
  join.return([join.load(integer(32), join.parameters[0]!)]);
  const ssa = constructSSA(b.finish(entry, [integer(32)])).value as SSAForm;
  const types = recoverTypes(ssa, sysvAMD64Abi, createOperationContext(), options);
  const shape = types.shapes.find((shape) => shape.base.kind === 'value')!;
  assert.equal(shape.base.kind, 'value');
  if (shape.base.kind !== 'value') return;
  assert.equal(shape.base.value_id, join.parameters[0]!.id);
  const pointerIds = new Set(types.types.filter((record) => record.definition.kind === 'pointer').map((record) => record.id));
  assert.equal(types.associations.some((association) => pointerIds.has(association.type_id) &&
    (association.subject_id === p.id || association.subject_id === q.id)), false);
});
