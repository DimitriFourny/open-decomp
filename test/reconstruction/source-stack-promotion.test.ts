import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, newIdentity, type AbiProfile } from '../../src/core/index.js';
import { darwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import { windowsX64Abi } from '../../src/abi/windows-x64/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../src/analysis/types/index.js';
import { integer, type RegisterIR, type SSAForm } from '../../src/ir/index.js';
import { structureControlFlow } from '../../src/presentation/index.js';
import { reconstruct, type Reconstruction } from '../../src/reconstruction/index.js';
import { builder, image, slice } from '../ir/support.js';
import { emit, emittedFormals, execute } from '../emitters/c/support.js';

const u64 = integer(64),
  u32 = integer(32);
const targets = [darwinArm64Abi, sysvAMD64Abi, windowsX64Abi];
function prepare(input: RegisterIR, abi: AbiProfile) {
  const ir = constructSSA(input).value as SSAForm;
  const types = recoverTypes(ir, abi, createOperationContext(), {
    image_id: image,
    slice_id: slice,
    revision: 0,
  });
  const structured = structureControlFlow(ir, createOperationContext());
  assert.ok(structured.value);
  const extra = { types, source: { abi, callees: [], addresses: [] } };
  return {
    ir,
    extra,
    view: (view: 'source' | 'checked') =>
      reconstruct({ function: structured.value!, ...extra }, createOperationContext(), view),
  };
}
function firstArgument(abi: AbiProfile) {
  const location = abi.classifyCall({
    returns: { kind: 'void' },
    parameters: [{ kind: 'integer', bits: 64, signed: false }],
    variadic: false,
    fixed_parameter_count: 1,
  }).parameters[0]!.locations[0]!;
  assert.equal(location.kind, 'register');
  if (location.kind !== 'register') throw new Error('Expected register argument');
  return location.register;
}
function rules(program: Reconstruction) {
  return (
    program.local_validation
      ?.filter((record) => record.kind === 'presentation')
      .map((record) => record.rule) ?? []
  );
}

for (const abi of targets) {
  test(`${abi.id}: private slots stay disjoint from external stores only before any escape`, () => {
    for (const escape of [false, true]) {
      const b = builder(`external-store-private-${abi.id}-${escape}`),
        block = b.block('entry');
      const pointer = block.readRegister(firstArgument(abi));
      const slot = block.int(
        'sub',
        block.readRegister(abi.stack_pointer),
        block.constant(u64, 24n),
      );
      block.store(slot, block.constant(u64, 77n));
      if (escape) block.store(pointer, slot);
      block.store(pointer, block.constant(u64, 19n));
      block.return([block.load(u64, slot)]);
      const fixture = prepare(b.finish(block, [u64]), abi);
      assert.equal(rules(fixture.view('source')).includes('private_stack_promotion'), !escape);
      assert.ok(!rules(fixture.view('checked')).includes('private_stack_promotion'));
      if (escape) continue;
      assert.ok(
        fixture
          .view('source')
          .local_validation_session?.abiConformance.some(
            (site) => site.rule === 'frame_private_to_activation',
          ),
      );
      for (const language of ['c-like', 'python-like'] as const) {
        const output = emit(fixture.ir, fixture.extra, language).emission;
        assert.doesNotMatch(output.text, /entry_sp|stack_frame/);
        const argument = emittedFormals(output)[0]!;
        const memory = new Map(
          Array.from({ length: 8 }, (_, index) => [0xa000n + BigInt(index), 0] as const),
        );
        const observation = execute(output, new Map([[argument.statement_id, 0xa000n]]), memory);
        assert.deepEqual(observation.values, [77n]);
        assert.equal(observation.memory.get(0xa000n), 19);
        assert.deepEqual(observation.events, ['store']);
      }
    }
  });

  test(`${abi.id}: open calls block preceding slots, not fresh post-call storage`, () => {
    for (const before of [false, true]) {
      const b = builder(`post-call-slot-${abi.id}-${before}`),
        block = b.block('entry');
      const slot = block.int(
        'sub',
        block.readRegister(abi.stack_pointer),
        block.constant(u64, 32n),
      );
      block.writeRegister(abi.stack_pointer, slot);
      if (before) block.store(slot, block.constant(u64, 77n));
      block.call(
        { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
        [],
        [],
        { registers: [], flags: [], memory: 'unknown_read_write' },
        [newIdentity('evidence')],
      );
      if (!before) block.store(slot, block.constant(u64, 77n));
      block.return([block.load(u64, slot)]);
      const fixture = prepare(b.finish(block, [u64]), abi);
      assert.equal(rules(fixture.view('source')).includes('private_stack_promotion'), !before);
    }
  });

  test(`${abi.id}: mixed-width overlap and unknown effects retain explicit frame memory`, () => {
    for (const gate of ['overlap', 'unknown', 'volatile'] as const) {
      const b = builder(`private-gate-${abi.id}-${gate}`),
        block = b.block('entry');
      const slot = block.int(
        'sub',
        block.readRegister(abi.stack_pointer),
        block.constant(u64, 24n),
      );
      block.store(slot, block.constant(u64, 77n), {
        endian: 'little',
        alignment: 1,
        volatile: gate === 'volatile',
      });
      if (gate === 'unknown')
        block.unknown('unmodeled effect', {
          registers: [],
          flags: [],
          memory: 'unknown_read_write',
        });
      block.return([block.load(gate === 'overlap' ? u32 : u64, slot)]);
      const fixture = prepare(b.finish(block, [gate === 'overlap' ? u32 : u64]), abi);
      assert.ok(!rules(fixture.view('source')).includes('private_stack_promotion'));
    }
  });

  test(`${abi.id}: named joined locals inline repeated reloads but never across their own write`, () => {
    for (const overwrite of [false, true]) {
      const b = builder(`joined-local-${abi.id}-${overwrite}`),
        entry = b.block('entry'),
        yes = b.block('yes'),
        no = b.block('no'),
        join = b.block('join');
      const pointer = entry.readRegister(firstArgument(abi));
      const slot = entry.int(
        'sub',
        entry.readRegister(abi.stack_pointer),
        entry.constant(u64, 56n),
      );
      entry.branch(
        entry.compare('eq', pointer, entry.constant(u64, 0xa000n)),
        entry.edge(yes),
        entry.edge(no),
      );
      yes.store(slot, yes.constant(u64, 7n));
      yes.jump(join);
      no.store(slot, no.constant(u64, 13n));
      no.jump(join);
      const first = join.load(u64, slot);
      join.store(pointer, join.constant(u64, 19n));
      if (overwrite) join.store(slot, join.constant(u64, 99n));
      const second = join.load(u64, slot);
      join.return([join.int('add', first, second)]);
      const fixture = prepare(b.finish(entry, [u64]), abi);
      for (const language of ['c-like', 'python-like'] as const) {
        const output = emit(fixture.ir, fixture.extra, language).emission;
        assert.match(output.text, /local_38/);
        if (!overwrite) assert.doesNotMatch(output.text, /value\\d+ = local_38/);
        const argument = emittedFormals(output)[0]!;
        for (const address of [0xa000n, 0xa008n]) {
          const memory = new Map(
            Array.from({ length: 8 }, (_, index) => [address + BigInt(index), 0] as const),
          );
          const observation = execute(output, new Map([[argument.statement_id, address]]), memory);
          const initial = address === 0xa000n ? 7n : 13n;
          assert.deepEqual(observation.values, [initial + (overwrite ? 99n : initial)]);
          assert.deepEqual(observation.events, ['store']);
        }
      }
    }
  });
}
