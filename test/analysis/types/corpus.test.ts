import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, entityIdentity, type AbiProfile, type LoadedImage } from '../../../src/core/index.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { WindowsX64Abi } from '../../../src/abi/windows-x64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { recoverTypes, type SuppliedTypeRecord } from '../../../src/analysis/types/index.js';
import type { RegisterIR } from '../../../src/ir/index.js';
import { discover, lift, loadCorpus as loadDarwin } from '../../lifters/arm64/support.js';
import { loadCorpus as loadWindows } from '../../lifters/x86_64/helpers.js';

function recoverFixture(image: LoadedImage, abi: AbiProfile, ir: RegisterIR) {
  const construction = constructSSA(ir); assert.equal(construction.state, 'complete');
  if (construction.value.form !== 'ssa') throw new Error('Expected SSA');
  return { program: construction.value, options: { slice_id: image.selected_slice_id, image_id: image.id, revision: 0 }, abi };
}
function checkMemory(image: LoadedImage, abi: AbiProfile, ir: RegisterIR): void {
  const { program, options } = recoverFixture(image, abi, ir);
  const word = entityIdentity(image.selected_slice_id, 'fixture-source-type', 'u64');
  const pointer = entityIdentity(image.selected_slice_id, 'fixture-source-type', 'u64-pointer');
  const types: SuppliedTypeRecord[] = [
    { id: word, definition: { kind: 'integer', bits: 64, signed: false }, source: 'user', status: 'asserted', evidence_ids: [] },
    { id: pointer, definition: { kind: 'pointer', bits: 64, to: word }, source: 'user', status: 'asserted', evidence_ids: [] },
  ];
  // Independent fixture source declaration, explicitly an assertion rather than
  // a claim that function names are sufficient to recover prototypes.
  const result = recoverTypes(program, abi, createOperationContext(), { ...options, types, signatures: [{ id: 'fixture-source-memory', subject_id: program.id, source: 'user', status: 'asserted', evidence_ids: [], signature: {
    abi: abi.id, return_type: word, parameters: [pointer, word].map((type_id, index) => ({ id: entityIdentity(image.selected_slice_id, 'fixture-parameter', [program.id, index]), name: null, type_id })), variadic: false, noreturn: false, evidence_ids: [],
  } }] });
  assert.equal(result.state, 'complete'); assert.equal(result.signatures[0]!.abi_state, 'complete');
  const shape = result.shapes.find(shape => shape.base.kind === 'value' && shape.fields.some(field => field.offset === 0n && field.width_bits === 64))!;
  assert.ok(shape); assert.deepEqual(shape.observed_extent, { start: 0n, end: 8n });
  const field = shape.fields.find(field => field.offset === 0n && field.width_bits === 64)!;
  assert.deepEqual([...field.access].sort(), ['read', 'write']);
  assert.ok(result.associations.some(item => item.subject_id === field.id && item.type_id === word && item.status === 'asserted'));
  const shapeType = result.types.find(type => type.id === shape.type_id)!.definition;
  assert.equal(shapeType.kind, 'structure'); if (shapeType.kind !== 'structure') throw new Error('Expected shape');
  assert.equal(shapeType.size, null); assert.equal(shapeType.fields[0]!.offset, 0n);
  assert.ok(result.associations.some(item => item.type_id === word && item.machine_type?.kind === 'integer' && item.machine_type.bits === 64));
}
function checkStack(image: LoadedImage, abi: AbiProfile, ir: RegisterIR): void {
  const { program, options } = recoverFixture(image, abi, ir);
  const result = recoverTypes(program, abi, createOperationContext(), options);
  assert.equal(result.state, 'complete');
  const stack = result.shapes.find(shape => shape.base.kind === 'stack')!;
  assert.ok(stack.fields.some(field => field.offset < 0n && field.width_bits === 32 && field.stack_region === 'local_candidate'));
  // LLVM disassembly: the 16-byte frame's lowest access is [SP + 4], not its allocation boundary.
  assert.equal(stack.observed_extent!.start, -12n);
  assert.deepEqual(result.signatures, []);
}
function checkVector(image: LoadedImage, abi: AbiProfile, ir: RegisterIR): void {
  const { program, options } = recoverFixture(image, abi, ir);
  const result = recoverTypes(program, abi, createOperationContext(), options);
  assert.equal(result.state, 'complete');
  assert.ok(result.types.some(type => type.definition.kind === 'vector' && type.definition.lanes === 4));
  assert.ok(result.associations.some(item => item.machine_type?.kind === 'vector' && item.machine_type.lanes === 4 && item.status === 'candidate'));
  assert.ok(result.shapes.some(shape => shape.fields.some(field => field.width_bits === 128)));
}

test('real Mach-O memory, stack and vector functions retain useful nonrewriting type associations', () => {
  const image = loadDarwin(), graphs = new Map(discover(image).map(graph => [graph.function.original_name, graph])), abi = new DarwinArm64Abi();
  checkMemory(image, abi, lift(graphs.get('_fixture_memory')!).ir);
  checkStack(image, abi, lift(graphs.get('_fixture_stack')!).ir);
  checkVector(image, abi, lift(graphs.get('_fixture_vector')!).ir);
});

test('real PE memory, stack and vector functions retain useful nonrewriting type associations', () => {
  const corpus = loadWindows(), abi = new WindowsX64Abi();
  checkMemory(corpus.image, abi, corpus.lifted.get(0x180001070n)!.ir);
  checkStack(corpus.image, abi, corpus.lifted.get(0x180001000n)!.ir);
  checkVector(corpus.image, abi, corpus.lifted.get(0x180001170n)!.ir);
});
