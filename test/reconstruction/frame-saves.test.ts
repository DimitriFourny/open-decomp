import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationContext,
  type AbiProfile,
  type RegisterDescriptor,
} from '../../src/core/index.js';
import { darwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import { windowsX64Abi } from '../../src/abi/windows-x64/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../src/analysis/types/index.js';
import { evaluateIR, integer, type SSAForm } from '../../src/ir/index.js';
import { newIdentity } from '../../src/core/index.js';
import { structureControlFlow } from '../../src/presentation/index.js';
import { reconstruct } from '../../src/reconstruction/index.js';
import { builder, image, slice } from '../ir/support.js';
import { acknowledgeRequirements, emit, emittedFormals, execute } from '../emitters/c/support.js';
import { assertMatchesIR, savedFrame, sourcePlan } from './frame-support.js';

const u64 = integer(64);
type Shape = 'shrink-wrapped' | 'modified-early' | 'slot-escapes' | 'other-object-escapes';

/** The save lives only in one branch (shrink wrapping); the other path returns
 * with the register never touched. */
function shrinkWrapped(abi: AbiProfile, saved: RegisterDescriptor, shape: Shape) {
  const b = builder(`shrink-wrapped-${abi.id}-${saved.id}-${shape}`),
    entry = b.block('entry'),
    work = b.block('work'),
    early = b.block('early');
  const location = abi.classifyCall({
    returns: { kind: 'void' },
    parameters: [{ kind: 'integer', bits: 64, signed: false }],
    variadic: false,
    fixed_parameter_count: 1,
  }).parameters[0]!.locations[0]!;
  assert.equal(location.kind, 'register');
  if (location.kind !== 'register') throw new Error('Expected register argument');
  const argument = location.register;
  const original = entry.readRegister(saved);
  const stackEntry = entry.readRegister(abi.stack_pointer);
  const condition = entry.extract(entry.readRegister(argument), 0, 1);
  entry.branch(condition, entry.edge(work), entry.edge(early));
  const frame = work.int('sub', stackEntry, work.constant(u64, 64n)),
    slot = work.int('add', frame, work.constant(u64, 32n));
  work.writeRegister(abi.stack_pointer, frame);
  work.store(slot, original);
  work.writeRegister(saved, work.constant(u64, 5n));
  const object =
    shape === 'other-object-escapes' ? frame : shape === 'slot-escapes' ? slot : undefined;
  if (object) work.writeRegister(argument, object);
  work.call(
    { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
    [],
    [],
    abi.unknown_call_clobbers,
    [newIdentity('evidence')],
  );
  work.writeRegister(saved, work.load(u64, slot));
  work.writeRegister(abi.stack_pointer, stackEntry);
  work.return([work.constant(u64, 7n)]);
  if (shape === 'modified-early') early.writeRegister(saved, early.constant(u64, 9n));
  early.return([early.constant(u64, 7n)]);
  const ir = constructSSA(b.finish(entry, [u64])).value as SSAForm;
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
  };
}
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
  | 'branch-unrestored'
  | 'simd-effect'
  | 'simd-vector-escape'
  | 'opaque-effect';

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
  // An ISA-bounded unlifted SIMD instruction between save and reload: it
  // clobbers a vector register and no memory, unless a vector input carries
  // a frame address (`simd-vector-escape`); `opaque-effect` may write memory.
  if (gate === 'simd-effect' || gate === 'simd-vector-escape' || gate === 'opaque-effect') {
    const vector = abi.unknown_call_clobbers.registers.find(
      (register) => register.bank === 'vector',
    )!;
    if (gate === 'simd-vector-escape')
      block.writeRegister(vector, block.cast('zero_extend', integer(vector.width_bits), slot));
    block.unknown('Unsupported SIMD instruction', {
      registers: [vector],
      flags: [],
      memory: gate === 'opaque-effect' ? 'unknown_read_write' : 'none',
    });
  }
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
    'opaque-effect',
    'simd-vector-escape',
  ] as const)
    test(`${abi.id}: ${gate} refuses frame-save inference`, () => {
      const { source } = fixture(abi, saved, gate);
      assert.equal(source.source?.frame_saves?.stores.size ?? 0, 0);
      assert.ok(!source.local_validation?.some((record) => record.rule === 'frame_save'));
    });
  test(`${abi.id}: a save is elided across a memory-free unknown effect`, () => {
    const { ir, extra, source, checked } = fixture(abi, saved, 'simd-effect');
    assert.equal(source.source?.frame_saves?.stores.size, 1);
    assert.equal(source.source?.frame_saves?.reloads.size, 1);
    assert.ok(
      source.local_validation_session?.abiConformance.some((site) => site.rule === 'frame_save'),
    );
    assert.equal(checked.source?.frame_saves, undefined);
    // Both the IR and the emitted program stop at the ordered unknown effect,
    // with no memory event before it.
    const evaluated = evaluateIR(ir, {
      registers: new Map([
        [abi.stack_pointer.root, 0x9000n],
        [saved.root, 0x1234n],
      ]),
      memory: [{ base: 0x8f00n, bytes: new Uint8Array(0x100), writable: true }],
    });
    assert.equal(evaluated.status, 'unknown');
    assert.equal(evaluated.reason, 'Unsupported SIMD instruction');
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
      assert.equal(result.exit, 'unknown');
      assert.deepEqual(result.events, ['unknown']);
    }
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

for (const abi of [sysvAMD64Abi, windowsX64Abi]) {
  const saved = abi.preserved.find(
    (register) => register.bank === 'integer' && register.root !== abi.stack_pointer.root,
  )!;
  test(`${abi.id}: a save inside one branch is elided when the other path leaves the register untouched`, () => {
    const { ir, extra, source } = shrinkWrapped(abi, saved, 'shrink-wrapped');
    assert.equal(source.source?.frame_saves?.stores.size, 1);
    assert.equal(source.source?.frame_saves?.reloads.size, 1);
    assert.ok(
      source.local_validation_session?.abiConformance.some((site) => site.rule === 'frame_save'),
    );
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(ir, extra, language).emission;
      assert.doesNotMatch(output.text, /unknown_value|entry_sp|stack_frame|\blocal\d/);
      const condition = emittedFormals(output)[0];
      assert.ok(condition);
      for (const taken of [0n, 1n]) {
        const result = execute(
          output,
          new Map([[condition.statement_id, taken]]),
          new Map(),
          0n,
          new Map(),
          new Map(),
          new Map([['sub_2000', () => []]]),
          acknowledgeRequirements(output),
        );
        assert.deepEqual(result.values, [7n]);
      }
    }
  });
  test(`${abi.id}: a path that modifies the register without restoring it refuses the save`, () => {
    const { source } = shrinkWrapped(abi, saved, 'modified-early');
    assert.equal(source.source?.frame_saves?.stores.size ?? 0, 0);
  });
  test(`${abi.id}: a save slot whose own address escapes is not elided`, () => {
    const { source } = shrinkWrapped(abi, saved, 'slot-escapes');
    assert.equal(source.source?.frame_saves?.stores.size ?? 0, 0);
  });
  test(`${abi.id}: an escaped frame object elsewhere does not expose the save slot`, () => {
    const { source } = shrinkWrapped(abi, saved, 'other-object-escapes');
    assert.equal(source.source?.frame_saves?.stores.size, 1);
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

/** A3: an escaped u32 at entry-SP -24 and a u32 at -16 kept as memory below
 * a save area. `trimmed`: the save is `[-8, 0)`, so every byte from the
 * lowest save slot to the entry SP is hidden and the object ends at -8.
 * `local-above-save`: the save is `[-16, -8)` and a u64 kept as memory lies at
 * `[-8, 0)`; `gap-above-save`: the save is `[-16, -8)` and `[-8, 0)` is
 * untouched. Neither may end the object below the entry SP. */
for (const abi of [darwinArm64Abi, sysvAMD64Abi, windowsX64Abi])
  for (const shape of ['trimmed', 'local-above-save', 'gap-above-save'] as const)
    test(`${abi.id}: the trimmed frame object never drops a byte that is not a hidden save (${shape})`, () => {
      const u32 = integer(32);
      const f = savedFrame(abi, `trim-${shape}`, shape === 'trimmed' ? -8n : -16n);
      const base = f.at(-24n);
      f.block.store(base, f.block.constant(u32, 3n));
      if (shape === 'trimmed') f.block.store(f.at(-16n), f.block.constant(u32, 4n));
      if (shape === 'local-above-save') f.block.store(f.at(-8n), f.argument);
      f.call(base);
      let sum = f.block.cast('zero_extend', u64, f.block.load(u32, base));
      if (shape === 'trimmed')
        sum = f.block.int(
          'add',
          sum,
          f.block.cast('zero_extend', u64, f.block.load(u32, f.at(-16n))),
        );
      if (shape === 'local-above-save') sum = f.block.int('add', sum, f.block.load(u64, f.at(-8n)));
      const fixture = f.finish(sum);
      const plan = sourcePlan(fixture),
        stack = plan.source?.stack,
        saves = plan.source?.frame_saves?.bytes;
      assert.ok(stack?.kind === 'object' && saves?.size === 8);
      const end = stack.minimum_offset + stack.size;
      assert.equal(end, shape === 'trimmed' ? -8n : 0n);
      // Every byte between the object and the entry SP is a hidden save byte,
      // and every member lies inside the object.
      for (let byte = end; byte < 0n; byte++) assert.ok(saves.has(byte), `${byte}`);
      for (const member of stack.members) assert.ok(member.offset + member.size <= end);
      assert.equal(
        plan.local_validation?.some((record) => record.rule === 'frame_object_save_area'),
        shape === 'trimmed',
      );
      const c = emit(fixture.ir, fixture.extra).emission.text,
        python = emit(fixture.ir, fixture.extra, 'python-like').emission.text;
      if (shape === 'trimmed') {
        assert.match(c, /uint32_t local_10;\s+uint8_t pad_c\[4\];\s+\} frame;/, c);
        assert.match(python, /frame = stack_frame\(\d+, 16, -0x8\)/, python);
      } else assert.match(python, /frame = stack_frame\(\d+, 16\)/, python);
      assertMatchesIR(fixture, abi, [0n, 1n, 0x1234n, (1n << 64n) - 1n]);
    });
