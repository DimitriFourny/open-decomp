import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext } from '../../../src/core/index.js';
import { constructSSA, type AnalysisResult } from '../../../src/analysis/ssa/index.js';
import { evaluateIR, integer, verifyIR, type RegisterIR, type SSAForm, type TrustedCall } from '../../../src/ir/index.js';
import { builder, image, register, returned } from '../../ir/support.js';

const i64 = integer(64);
const mask64 = (1n << 64n) - 1n;
const target = { kind: 'direct' as const,
  address: { image_id: image, space: 'va' as const, value: 0x2000n } };

function converted(value: AnalysisResult<RegisterIR | SSAForm>): SSAForm {
  assert.equal(value.state, 'complete', JSON.stringify(value.diagnostics));
  if (value.value.form !== 'ssa') throw new TypeError('Expected complete SSA');
  assert.deepEqual(verifyIR(value.value), []);
  return value.value;
}

test('source tracking retains actual writes and observable capabilities without materializing unrelated clobbers', () => {
  const ir = builder('source-ssa-clobber-only-budget'), entry = ir.block('entry');
  const result = register('observable-result', 64, 0, 'replace_root', 'source-result');
  const preserved = register('observable-preserved', 64, 0, 'replace_root', 'source-preserved');
  const written = register('actual-write-only', 64, 0, 'replace_root', 'source-written');
  const unrelated = Array.from({ length: 64 }, (_, index) =>
    register(`unrelated-${index}`, 64, 0, 'replace_root', `source-unrelated-${index}`));
  entry.writeRegister(written, entry.constant(i64, 17n));
  entry.call(target, [], [], { registers: [result, preserved, ...unrelated],
    flags: [], memory: 'unknown_read_write' });
  let previous = entry;
  for (let index = 0; index < 16; index++) {
    const next = ir.block(`successor-${index}`);
    previous.jump(next);
    previous = next;
  }
  previous.return([previous.readRegister(result)]);
  const input = ir.finish(entry, [i64]);
  const full = converted(constructSSA(input));
  const capabilities = new Map([[result.root, mask64], [preserved.root, mask64]]);
  const source = converted(constructSSA(input, {
    observable_register_masks: capabilities, max_work: 2000,
  }));
  assert.deepEqual([...capabilities], [[result.root, mask64], [preserved.root, mask64]],
    'Actual uses do not mutate ABI capacity');
  assert.equal(full.register_states[0]!.entry.length, 67);
  assert.equal(source.register_states[0]!.entry.length, 3);
  for (const row of source.register_states) {
    assert.deepEqual(row.entry.map((binding) => binding.register.root),
      [written.root, result.root, preserved.root]);
    const original = full.register_states.find((state) => state.block === row.block)!;
    assert.deepEqual(row.entry.map((binding) => binding.value.id),
      original.entry.filter((binding) => capabilities.has(binding.register.root) ||
        binding.register.root === written.root).map((binding) => binding.value.id));
  }
  const originalCall = input.blocks[0]!.instructions.find((node) => node.kind === 'call')!;
  const sourceCall = source.blocks[0]!.instructions.find((node) => node.kind === 'call')!;
  assert.deepEqual(sourceCall.clobbers, originalCall.clobbers);
  assert.deepEqual(sourceCall.provenance, originalCall.provenance);
  const call: TrustedCall = (input) => {
    assert.equal(input.readRegister(preserved), 99n);
    return { results: [], writes: [], register_writes: [
      { register: result, bits: 42n }, { register: preserved, bits: 99n },
    ] };
  };
  const evaluated = evaluateIR(source, {
    registers: new Map([[preserved.root, 99n]]), calls: new Map([[sourceCall.id, call]]),
  });
  assert.deepEqual(returned(evaluated), [42n]);
  assert.equal(evaluated.registers.get(written.root)!.bits, 17n);
  assert.equal(evaluated.registers.get(preserved.root)!.bits, 99n);
  assert.deepEqual(evaluated.effect_trace, [sourceCall.id]);
});

test('a later actual read retains earlier partial clobber boundaries even outside capability roots', () => {
  const ir = builder('source-ssa-late-read-slice'), entry = ir.block('entry');
  const whole = register('late-whole', 64, 0, 'replace_root', 'late-actual-root');
  const byte = register('earlier-clobber-byte', 8, 24, 'preserve_other_bits', whole.root);
  entry.call(target, [], [], { registers: [byte], flags: [], memory: 'unknown_read_write' });
  entry.return([entry.readRegister(whole)]);
  const input = ir.finish(entry, [i64]), capabilities = new Map<string, bigint>();
  const source = converted(constructSSA(input, { observable_register_masks: capabilities }));
  assert.equal(capabilities.size, 0);
  assert.deepEqual(source.register_states[0]!.entry.map(({ register }) =>
    [register.offset_bits, register.width_bits]), [[0, 24], [24, 8], [32, 32]]);
  const call = source.blocks[0]!.instructions.find((node) => node.kind === 'call')!;
  assert.deepEqual(call.register_outputs.map(({ register }) =>
    [register.offset_bits, register.width_bits]), [[24, 8]]);
  const oracle: TrustedCall = () => ({ results: [], writes: [],
    register_writes: [{ register: byte, bits: 0xaan }] });
  assert.deepEqual(returned(evaluateIR(source, {
    registers: new Map([[whole.root, 0x1122334455667788n]]), calls: new Map([[call.id, oracle]]),
  })), [0x11223344aa667788n]);
});

test('unknown effects preserve full metadata and observable preserved outputs under source tracking', () => {
  const ir = builder('source-ssa-unknown-preserved'), entry = ir.block('entry');
  const preserved = register('preserved', 64, 0, 'replace_root', 'observable-preserved-root');
  const unused = register('unobserved', 64, 0, 'replace_root', 'unobserved-caller-saved-root');
  entry.unknown('A real unsupported instruction remains opaque', {
    registers: [preserved, unused], flags: [], memory: 'unknown_read_write',
  });
  entry.return([entry.constant(i64, 7n)]);
  const input = ir.finish(entry, [i64]);
  const source = converted(constructSSA(input, { observable_register_masks: new Map([[preserved.root, mask64]]) }));
  const effect = source.blocks[0]!.instructions.find((node) => node.kind === 'unknown_effect')!;
  assert.deepEqual(effect.clobbers.registers, [preserved, unused]);
  assert.equal(effect.clobbers.memory, 'unknown_read_write');
  assert.deepEqual(effect.register_outputs.map(({ register }) => register.root), [preserved.root]);
  assert.equal(evaluateIR(source).status, 'unknown');
  assert.equal(evaluateIR(source).reason, 'A real unsupported instruction remains opaque');
  const invalid = { ...source, blocks: source.blocks.map((block) => ({ ...block,
    instructions: block.instructions.map((node) => node.id === effect.id
      ? { ...effect, clobbers: { ...effect.clobbers,
        registers: [preserved, { ...unused, width_bits: 65 }] } } : node),
  })) };
  assert.ok(verifyIR(invalid).some((issue) => issue.code === 'register'),
    'Untracked clobber metadata is still validated');
  const limited = constructSSA(input, { observable_register_masks: new Map(), max_work: 0 });
  assert.equal(limited.value, input);
  assert.equal(limited.diagnostics[0]!.code, 'resource_limit');
  const controller = new AbortController();
  controller.abort();
  const cancelled = constructSSA(input, { observable_register_masks: new Map(),
    checkpoint: createOperationContext({ signal: controller.signal }).checkpoint });
  assert.equal(cancelled.value, input);
  assert.equal(cancelled.diagnostics[0]!.code, 'cancelled');
});

test('preserved low vector slices remain opaque while later upper reads or writes keep the whole root', () => {
  for (const access of ['none', 'read-upper', 'write-upper'] as const) {
    const ir = builder(`source-ssa-preserved-low-${access}`), entry = ir.block('entry');
    const whole = { ...register('whole-vector', 128, 0, 'replace_root', 'preserved-vector', 128),
      bank: 'vector' as const };
    const upper = { ...whole, id: 'actual-upper', offset_bits: 64, width_bits: 64,
      write_rule: 'preserve_other_bits' as const };
    entry.unknown('Unsupported instruction can clobber preserved bits', {
      registers: [whole], flags: [], memory: 'unknown_read_write',
    });
    if (access === 'write-upper') entry.writeRegister(upper, entry.constant(i64, 0xaan));
    entry.return(access === 'read-upper' ? [entry.readRegister(upper)] : [entry.constant(i64, 7n)]);
    const source = converted(constructSSA(ir.finish(entry, [i64]), {
      observable_register_masks: new Map([[whole.root, mask64]]),
    }));
    const expected = access === 'none' ? [[0, 64]] : [[0, 64], [64, 64]];
    assert.deepEqual(source.register_states[0]!.entry.map(({ register }) =>
      [register.offset_bits, register.width_bits]), expected);
    const effect = source.blocks[0]!.instructions.find((node) => node.kind === 'unknown_effect')!;
    assert.deepEqual(effect.register_outputs.map(({ register }) =>
      [register.offset_bits, register.width_bits]), expected);
    assert.deepEqual(effect.clobbers.registers, [whole]);
    assert.equal(effect.clobbers.memory, 'unknown_read_write');
    assert.equal(evaluateIR(source).status, 'unknown');
  }
});

test('disjoint observable storage masks split exact bit runs across word boundaries', () => {
  const ir = builder('source-ssa-disjoint-observable-mask'), entry = ir.block('entry');
  const whole = { ...register('whole', 128, 0, 'replace_root', 'disjoint-mask-root', 128),
    bank: 'vector' as const };
  entry.unknown('Opaque clobber of two independently observable slices', {
    registers: [whole], flags: [], memory: 'unknown_read_write',
  });
  entry.return([entry.constant(i64, 0n)]);
  const mask = (7n << 31n) | (7n << 95n);
  const source = converted(constructSSA(ir.finish(entry, [i64]), {
    observable_register_masks: new Map([[whole.root, mask]]),
  }));
  assert.deepEqual(source.register_states[0]!.entry.map(({ register }) =>
    [register.offset_bits, register.width_bits]), [[31, 3], [95, 3]]);
  const effect = source.blocks[0]!.instructions.find((node) => node.kind === 'unknown_effect')!;
  assert.deepEqual(effect.register_outputs.map(({ register }) =>
    [register.offset_bits, register.width_bits]), [[31, 3], [95, 3]]);
  assert.deepEqual(effect.clobbers.registers, [whole]);
});
