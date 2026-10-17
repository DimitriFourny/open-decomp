import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext } from '../../src/core/index.js';
import { sysvAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import type { TypeRecoveryResult } from '../../src/analysis/types/index.js';
import { integer, type RegisterIR, type SSAForm } from '../../src/ir/index.js';
import { structureControlFlow } from '../../src/presentation/index.js';
import { reconstruct } from '../../src/reconstruction/index.js';
import type { InferredCallee } from '../../src/reconstruction/source-model.js';
import { builder, image, register } from '../ir/support.js';

const i32 = integer(32),
  i64 = integer(64);
const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
const edi = register('edi', 32, 0, 'zero_extend_root', 'x86_64:rdi');
const rax = register('rax', 64, 0, 'replace_root');
const eax = register('eax', 32, 0, 'zero_extend_root');
const rbx = register('rbx', 64, 0, 'replace_root', 'x86_64:rbx');
function ssa(input: RegisterIR) {
  const result = constructSSA(input).value;
  assert.equal(result.form, 'ssa');
  return result as SSAForm;
}
function plan(input: SSAForm, callees: readonly InferredCallee[] = [], types?: TypeRecoveryResult) {
  const structured = structureControlFlow(input, createOperationContext());
  assert.ok(structured.value);
  return reconstruct(
    {
      function: structured.value,
      source: { abi: sysvAMD64Abi, callees, addresses: [] },
      ...(types ? { types } : {}),
    },
    createOperationContext(),
  );
}

test('source parameters group demanded ABI slices and omit scratch, preserved and fault snapshots', () => {
  const b = builder('source-parameters'),
    block = b.block('entry');
  const argument = block.readRegister(rdi);
  block.readRegister(edi);
  const saved = block.readRegister(rbx);
  block.writeRegister(register('r10', 64, 0, 'replace_root', 'x86_64:r10'), saved);
  block.load(i32, argument);
  block.return([argument]);
  const input = ssa(b.finish(block, [i64])),
    result = plan(input);
  assert.equal(result.parameters.length, 1);
  assert.deepEqual(result.parameters[0]!.type, i64);
  assert.equal(result.parameter_registers.get(result.parameters[0]!.id)?.root, rdi.root);
  assert.ok([...result.physical_inputs.values()].every((bindings) => bindings.length === 0));
  assert.ok([...result.returns.values()].every((boundary) => boundary.outputs.length === 0));
  assert.ok(result.source?.value_origins?.get(result.parameters[0]!.id)?.length);
});

test('exact call contracts assemble one pointer argument and retain a narrow result', () => {
  const b = builder('source-call-width'),
    block = b.block('entry');
  const argument = block.readRegister(rdi);
  block.readRegister(edi);
  block.call(
    { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
    [],
    [],
    { registers: [rax], flags: [], memory: 'unknown_read_write' },
  );
  const returned = block.readRegister(eax);
  block.return([returned]);
  const input = ssa(b.finish(block, [i32])),
    call = input.blocks[0]!.instructions.find((node) => node.kind === 'call')!;
  const types: TypeRecoveryResult = {
    state: 'complete',
    work: 0,
    subjects: [],
    associations: [],
    shapes: [],
    conflicts: [],
    evidence: [],
    diagnostics: [],
    calls: null,
    types: [
      {
        id: 'pointer',
        definition: { kind: 'integer', bits: 64, signed: false },
        source: 'debug',
        status: 'established',
        evidence_ids: [],
      },
      {
        id: 'int',
        definition: { kind: 'integer', bits: 32, signed: true },
        source: 'debug',
        status: 'established',
        evidence_ids: [],
      },
    ],
    signatures: [
      {
        id: 'call-signature',
        subject_id: call.id,
        source: 'debug',
        status: 'established',
        evidence_ids: [],
        abi_state: 'complete',
        implicit_register_inputs: [],
        signature: {
          abi: 'sysv-amd64',
          return_type: 'int',
          parameters: [{ id: 'argument', name: null, type_id: 'pointer' }],
          variadic: false,
          noreturn: false,
          evidence_ids: [],
        },
      },
    ],
  };
  const result = plan(input, [], types),
    projection = result.calls.get(call.id)!;
  assert.equal(projection.kind, 'source');
  assert.equal(projection.arguments.length, 1);
  assert.equal(projection.results.length, 1);
  assert.deepEqual(projection.arguments[0]!.type, i64);
  assert.deepEqual(projection.results[0]!.type, i32);
  assert.ok(result.live.has(projection.results[0]!.id));
  assert.equal(result.parameters.length, 1);
  assert.ok(result.retained.has(call.id));
  assert.ok(argument);
});

test('private initialized spills forward while saved-register frame traffic disappears', () => {
  const b = builder('source-private-spill'),
    block = b.block('entry');
  const sp = block.readRegister(sysvAMD64Abi.stack_pointer),
    argument = block.readRegister(rdi),
    saved = block.readRegister(rbx);
  const slot = block.int('sub', sp, block.constant(i64, 16n)),
    save = block.int('sub', sp, block.constant(i64, 8n));
  block.store(slot, argument);
  block.store(save, saved);
  const loaded = block.load(i64, slot);
  block.writeRegister(rbx, block.load(i64, save));
  block.return([loaded]);
  const input = ssa(b.finish(block, [i64])),
    result = plan(input);
  assert.equal(result.parameters.length, 1);
  assert.equal(result.source?.stack, null);
  assert.ok(
    input.blocks[0]!.instructions.filter(
      (node) => node.kind === 'load' || node.kind === 'store',
    ).every((node) => !result.retained.has(node.id)),
  );
  assert.equal(result.source?.locals.size, 0);
});

test('overlapping or escaping stack addresses retain ordered shared frame accesses', () => {
  const b = builder('source-shared-frame'),
    block = b.block('entry');
  const slot = block.int(
    'sub',
    block.readRegister(sysvAMD64Abi.stack_pointer),
    block.constant(i64, 16n),
  );
  block.store(slot, block.constant(i64, 7n));
  const loaded = block.load(i32, slot);
  block.writeRegister(rdi, slot);
  block.call(
    { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
    [],
    [],
    { registers: [], flags: [], memory: 'unknown_read_write' },
  );
  block.return([loaded]);
  const input = ssa(b.finish(block, [i32])),
    call = input.blocks[0]!.instructions.find((node) => node.kind === 'call')!;
  const result = plan(input, [
    {
      call_id: call.id,
      parameters: [rdi],
      returns: [],
      evidence_ids: [],
      parameter_state: 'observed',
    },
  ]);
  assert.ok(result.source?.stack);
  assert.equal(result.source.locals.size, 0);
  const effects = input.blocks[0]!.instructions.filter(
    (node) => node.kind === 'load' || node.kind === 'store' || node.kind === 'call',
  );
  assert.ok(effects.every((node) => result.retained.has(node.id)));
});

test('source DCE retains both branch effects and unresolved calls without snapshot arguments', () => {
  const b = builder('source-branch-effects'),
    entry = b.block('entry'),
    yes = b.block('yes'),
    no = b.block('no');
  const condition = entry.compare('eq', entry.readRegister(rdi), entry.constant(i64, 0n));
  entry.branch(condition, entry.edge(yes), entry.edge(no));
  yes.store(yes.constant(i64, 0x1000n), yes.constant(i64, 1n));
  yes.return();
  no.call({ kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } }, [], [], {
    registers: [rax],
    flags: [],
    memory: 'unknown_read_write',
  });
  no.return();
  const input = ssa(b.finish(entry)),
    result = plan(input);
  assert.equal(result.blocks.size, 3);
  assert.ok(result.live.has(condition.id));
  for (const node of input.blocks.flatMap((block) => block.instructions))
    if (node.kind === 'store' || node.kind === 'call') assert.ok(result.retained.has(node.id));
  const call = [...result.calls.values()][0]!;
  assert.equal(call.kind, 'physical');
  assert.equal(call.inputs.length, 0);
});

test('unchanged ABI values cross loop phis without transfer plumbing', () => {
  const b = builder('source-loop-identity'),
    entry = b.block('entry'),
    loop = b.block('loop'),
    exit = b.block('exit');
  const rcx = register('rcx', 64, 0, 'replace_root', 'x86_64:rcx');
  entry.readRegister(rdi);
  entry.writeRegister(rcx, entry.constant(i64, 3n));
  entry.jump(loop);
  const count = loop.int('sub', loop.readRegister(rcx), loop.constant(i64, 1n));
  loop.writeRegister(rcx, count);
  loop.branch(loop.compare('eq', count, loop.constant(i64, 0n)), loop.edge(exit), loop.edge(loop));
  exit.return([exit.readRegister(rdi)]);
  const input = ssa(b.finish(entry, [i64])),
    result = plan(input);
  assert.equal(result.parameters.length, 1);
  const forwarded = new Set(
    input.register_states.flatMap((state) =>
      state.entry
        .filter((binding) => binding.register.root === rdi.root)
        .map((binding) => binding.value.id),
    ),
  );
  assert.ok(
    [...result.transfers.values()].flat().every((copy) => !forwarded.has(copy.destination.id)),
  );
  assert.equal(result.blocks.size, 3);
});

test('a stack load missing an initializing predecessor stays memory, not a scalar', () => {
  const b = builder('source-maybe-initialized'),
    entry = b.block('entry'),
    yes = b.block('yes'),
    no = b.block('no'),
    exit = b.block('exit');
  entry.branch(
    entry.compare('eq', entry.readRegister(rdi), entry.constant(i64, 0n)),
    entry.edge(yes),
    entry.edge(no),
  );
  const yesSlot = yes.int(
    'sub',
    yes.readRegister(sysvAMD64Abi.stack_pointer),
    yes.constant(i64, 8n),
  );
  yes.store(yesSlot, yes.constant(i64, 9n));
  yes.jump(exit);
  no.jump(exit);
  const exitSlot = exit.int(
    'sub',
    exit.readRegister(sysvAMD64Abi.stack_pointer),
    exit.constant(i64, 8n),
  );
  exit.return([exit.load(i64, exitSlot)]);
  const input = ssa(b.finish(entry, [i64])),
    result = plan(input);
  const load = input.blocks
    .flatMap((block) => block.instructions)
    .find((node) => node.kind === 'load')!;
  assert.ok(result.retained.has(load.id));
  assert.ok(result.source?.stack);
  assert.equal(result.source.locals.size, 0);
});

test('whole vector ABI cells remain source inputs rather than becoming unknown', () => {
  const b = builder('source-vector-input'),
    block = b.block('entry');
  const xmm0 = {
    ...register('xmm0', 128, 0, 'preserve_other_bits', 'x86_64:zmm0', 512),
    bank: 'vector' as const,
  };
  const value = block.readRegister(xmm0);
  block.return([value]);
  const result = plan(ssa(b.finish(block, [integer(128)])));
  assert.equal(result.parameters.length, 1);
  assert.deepEqual(result.parameters[0]!.type, integer(128));
  assert.equal(result.parameter_registers.get(result.parameters[0]!.id)?.root, xmm0.root);
});

test('dead hardware return-address reads disappear but observed ones remain memory', () => {
  for (const observed of [false, true]) {
    const b = builder(`source-return-address-${observed}`),
      block = b.block('entry');
    const value = block.load(i64, block.readRegister(sysvAMD64Abi.stack_pointer));
    block.return(observed ? [value] : []);
    const input = ssa(b.finish(block, observed ? [i64] : [])),
      result = plan(input);
    const load = input.blocks[0]!.instructions.find((node) => node.kind === 'load')!;
    assert.equal(result.retained.has(load.id), observed);
    assert.equal(result.source?.stack !== null, observed);
  }
});

test('asserted narrow parameters preserve low arithmetic bits and materialize shared synthetic DAGs', () => {
  const b = builder('source-narrow-arithmetic'),
    block = b.block('entry');
  let value = block.readRegister(rdi);
  for (let index = 0; index < 12; index++) value = block.int('add', value, value);
  block.writeRegister(rax, block.int('xor', value, block.constant(i64, 0x55n)));
  block.return();
  const input = ssa(b.finish(block));
  const types: TypeRecoveryResult = {
    state: 'complete',
    work: 0,
    subjects: [],
    associations: [],
    shapes: [],
    conflicts: [],
    evidence: [],
    diagnostics: [],
    calls: null,
    types: [
      {
        id: 'uint32',
        definition: { kind: 'integer', bits: 32, signed: false },
        source: 'debug',
        status: 'asserted',
        evidence_ids: [],
      },
    ],
    signatures: [
      {
        id: 'function-signature',
        subject_id: input.id,
        source: 'debug',
        status: 'asserted',
        evidence_ids: [],
        abi_state: 'complete',
        implicit_register_inputs: [],
        signature: {
          abi: 'sysv-amd64',
          return_type: 'uint32',
          parameters: [{ id: 'argument', name: 'a', type_id: 'uint32' }],
          variadic: false,
          noreturn: false,
          evidence_ids: [],
        },
      },
    ],
  };
  const result = plan(input, [], types);
  assert.deepEqual(
    result.parameters.map((value) => value.type),
    [i32],
  );
  assert.deepEqual([...result.returns.values()][0]!.results[0]!.type, i32);
  assert.ok([...result.live].every((id) => result.expressions.get(id)?.kind !== 'indeterminate'));
  const definitions = [...result.source!.definitions!.values()].flat();
  assert.ok(definitions.length >= 12);
  assert.ok(definitions.every((definition) => !result.inline.has(definition.result.id)));
  const original = new Set(
    input.blocks.flatMap((block) => block.instructions.map((node) => node.id)),
  );
  assert.ok([...result.source!.definitions!.keys()].every((id) => original.has(id)));
});
