import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationContext,
  type AbiProfile,
  type RegisterDescriptor,
} from '../../src/core/index.js';
import { sysvAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import { windowsX64Abi } from '../../src/abi/windows-x64/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../src/analysis/types/index.js';
import { integer, type SSAForm } from '../../src/ir/index.js';
import { structureControlFlow } from '../../src/presentation/index.js';
import { reconstruct } from '../../src/reconstruction/index.js';
import { builder, image, slice } from '../ir/support.js';
import { acknowledgeRequirements, emit, emittedFormals, execute } from '../emitters/c/support.js';

const u64 = integer(64);
type Gate =
  | 'valid'
  | 'volatile'
  | 'overlap'
  | 'escape'
  | 'unrestored'
  | 'wrong-order'
  | 'second-store'
  | 'entry-slot'
  | 'return-address'
  | 'branch-unrestored';

function fixture(abi: AbiProfile, saved: RegisterDescriptor, gate: Gate = 'valid') {
  const b = builder(`frame-save-${abi.id}-${saved.id}-${gate}`),
    block = b.block('entry');
  const entry = block.readRegister(abi.stack_pointer);
  const slot = gate === 'entry-slot' ? entry : block.int('sub', entry, block.constant(u64, 32n));
  block.writeRegister(abi.stack_pointer, slot);
  const original = block.readRegister(saved);
  const access = { endian: 'little', alignment: 1, volatile: gate === 'volatile' } as const;
  block.store(slot, original, access);
  if (gate === 'second-store') block.store(slot, original);
  if (gate === 'overlap')
    block.store(block.int('add', slot, block.constant(u64, 1n)), block.constant(integer(8), 3n));
  // Frame-pointer setup does not turn this private address into an escape.
  if (saved.bank === 'integer') block.writeRegister(saved, slot);
  const loaded = block.load(integer(saved.width_bits), slot, access);
  const low = block.extract(loaded, 0, saved.width_bits / 2),
    high = block.extract(loaded, saved.width_bits / 2, saved.width_bits / 2);
  if (gate !== 'unrestored' && gate !== 'branch-unrestored')
    block.writeRegister(saved, block.concat(gate === 'wrong-order' ? [high, low] : [low, high]));
  block.writeRegister(abi.stack_pointer, entry);
  if (gate === 'branch-unrestored') {
    const restored = b.block('restored'),
      missing = b.block('missing');
    const condition = block.readRegister(
      abi.unknown_call_clobbers.registers.find((register) => register.bank === 'integer')!,
    );
    block.branch(block.extract(condition, 0, 1), block.edge(restored), block.edge(missing));
    restored.writeRegister(saved, loaded);
    restored.return([restored.constant(u64, 7n)]);
    missing.return([missing.constant(u64, 7n)]);
  } else if (gate === 'return-address') block.return([block.load(u64, entry)]);
  else block.return([gate === 'escape' ? slot : block.constant(u64, 7n)]);
  const ir = constructSSA(b.finish(block, [u64])).value as SSAForm;
  const types = recoverTypes(ir, abi, createOperationContext(), {
    image_id: image,
    slice_id: slice,
    revision: 0,
  });
  const extra = { types, source: { abi, callees: [], addresses: [] } };
  const structured = structureControlFlow(ir, createOperationContext());
  assert.ok(structured.value);
  return {
    ir,
    extra,
    source: reconstruct(
      { function: structured.value, ...extra },
      createOperationContext(),
      'source',
    ),
    checked: reconstruct(
      { function: structured.value, ...extra },
      createOperationContext(),
      'checked',
    ),
  };
}

for (const abi of [sysvAMD64Abi, windowsX64Abi]) {
  for (const saved of abi.preserved.filter(
    (register) =>
      register.root !== abi.stack_pointer.root &&
      (register.bank === 'integer' || register.bank === 'vector'),
  )) {
    test(`${abi.id}: leaf ${saved.id} save wins over scalar promotion and restores exact slices`, () => {
      const { ir, extra, source, checked } = fixture(abi, saved);
      assert.equal(source.source?.frame_saves?.stores.size, 1);
      assert.equal(source.source?.frame_saves?.reloads.size, 1);
      assert.equal(source.source?.locals.size, 0);
      assert.ok(
        source.local_validation?.some(
          (record) => record.kind === 'presentation' && record.rule === 'frame_save',
        ),
      );
      assert.ok(
        source.local_validation_session?.abiConformance.some((site) => site.rule === 'frame_save'),
      );
      assert.equal(checked.source?.frame_saves, undefined);
      assert.ok(!checked.local_validation?.some((record) => record.rule === 'frame_save'));
      for (const language of ['c-like', 'python-like'] as const) {
        const output = emit(ir, extra, language).emission;
        assert.doesNotMatch(output.text, /unknown_value|entry_sp|stack_frame|\blocal\d/);
        const result = execute(
          output,
          new Map(),
          new Map(),
          0n,
          new Map(),
          new Map(),
          new Map(),
          acknowledgeRequirements(output),
        );
        assert.deepEqual(result.values, [7n]);
        assert.deepEqual(result.events, []);
      }
    });
  }
  const saved = abi.preserved.find(
    (register) => register.bank === 'integer' && register.root !== abi.stack_pointer.root,
  )!;
  for (const gate of [
    'volatile',
    'overlap',
    'escape',
    'unrestored',
    'wrong-order',
    'second-store',
    'entry-slot',
    'branch-unrestored',
  ] as const)
    test(`${abi.id}: ${gate} refuses frame-save inference`, () => {
      const { source } = fixture(abi, saved, gate);
      assert.equal(source.source?.frame_saves?.stores.size ?? 0, 0);
      assert.ok(!source.local_validation?.some((record) => record.rule === 'frame_save'));
    });
  test(`${abi.id}: a caller-saved entry value is not a frame save`, () => {
    const scratch = abi.unknown_call_clobbers.registers.find(
      (register) => register.bank === 'integer',
    )!;
    const { source } = fixture(abi, scratch);
    assert.equal(source.source?.frame_saves?.stores.size ?? 0, 0);
  });
  test(`${abi.id}: hiding a save never hides an observed hardware return address`, () => {
    const { ir, extra, source } = fixture(abi, saved, 'return-address');
    assert.equal(source.source?.frame_saves?.stores.size, 1);
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(ir, extra, language).emission;
      assert.doesNotMatch(output.text, /unknown_value|stack_frame|\blocal\d/);
      const entry = emittedFormals(output).find((formal) => formal.name === 'entry_sp');
      assert.ok(entry);
      const memory = new Map<bigint, number>();
      for (let byte = 0; byte < 8; byte++) memory.set(0x9000n + BigInt(byte), byte + 1);
      const result = execute(
        output,
        new Map([[entry.statement_id, 0x9000n]]),
        memory,
        0n,
        new Map(),
        new Map(),
        new Map(),
        acknowledgeRequirements(output),
      );
      assert.deepEqual(result.values, [0x0807060504030201n]);
      assert.deepEqual(result.events, ['load']);
    }
  });
}

test('Windows x64 preserves only the low 128 bits of nonvolatile vector roots', () => {
  const xmm = windowsX64Abi.preserved.find((register) => register.bank === 'vector')!;
  const upper = windowsX64Abi.unknown_call_clobbers.registers.find(
    (register) => register.root === xmm.root,
  )!;
  for (const saved of [upper, { ...xmm, width_bits: 256 }]) {
    const { source } = fixture(windowsX64Abi, saved);
    assert.equal(source.source?.frame_saves?.stores.size ?? 0, 0);
    assert.ok(!source.local_validation?.some((record) => record.rule === 'frame_save'));
  }
});
