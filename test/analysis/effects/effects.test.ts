import assert from 'node:assert/strict';
import test from 'node:test';
import {
  instructionOperands,
  instructionResults,
  summarizeEffect,
} from '../../../src/analysis/effects/index.js';
import { integer } from '../../../src/ir/index.js';
import { builder, image, register, returned } from '../../ir/support.js';
import { equivalent, forms } from '../ssa/support.js';

const i8 = integer(8),
  i16 = integer(16),
  i32 = integer(32),
  i64 = integer(64);
const r = register('physical-state', 64, 0, 'replace_root', 'unpatterned-state-root');
const access = { endian: 'little' as const, alignment: 1, volatile: false };

test('overlapping alias stores and loads retain byte order and all effects through DCE', () => {
  const ir = builder('ssa-memory-alias');
  const b = ir.block('entry', [i64]);
  const address = b.parameters[0]!;
  b.store(address, b.constant(i32, 0x12345678n));
  b.store(b.int('add', address, b.constant(i64, 1n)), b.constant(i16, 0xabcdn));
  b.load(i8, address, { ...access, volatile: true });
  const value = b.load(i32, address);
  b.return([value]);
  const { original, optimized } = equivalent(ir.finish(b, [i32]), {
    arguments: [0x1000n],
    memory: [{ base: 0x1000n, bytes: new Uint8Array(4), writable: true }],
  });
  assert.deepEqual(returned(original), [0x12abcd78n]);
  assert.equal(optimized.blocks[0]!.instructions.filter((node) => 'effect_in' in node).length, 4);
  const effects = optimized.blocks[0]!.instructions.flatMap((node) => {
    const summary = summarizeEffect(node);
    return summary ? [summary] : [];
  });
  assert.deepEqual(
    effects.map((effect) => [effect.reads_memory, effect.writes_memory, effect.barrier]),
    [
      [false, true, true],
      [false, true, true],
      [true, false, true],
      [true, false, false],
    ],
  );
});

test('dead memory result still faults and materializes register state before the fault', () => {
  const ir = builder('ssa-dead-load-fault');
  const b = ir.block('entry');
  b.writeRegister(r, b.constant(i64, 42n));
  b.load(i32, b.constant(i64, 0x1000n));
  b.writeRegister(r, b.constant(i64, 99n));
  b.return();
  const result = equivalent(ir.finish(b));
  assert.equal(result.original.status, 'memory_fault');
  assert.equal(result.original.registers.get(r.root)!.bits, 42n);
  const load = result.optimized.blocks[0]!.instructions.find((node) => node.kind === 'load')!;
  assert.ok(load.kind === 'load' && load.register_inputs.length > 0);
});

test('faulting store remains even when another store follows at the same address', () => {
  const ir = builder('ssa-store-fault');
  const b = ir.block('entry');
  b.writeRegister(r, b.constant(i64, 5n));
  const address = b.constant(i64, 0x1000n);
  b.store(address, b.constant(i32, 1n));
  b.store(address, b.constant(i32, 2n));
  b.return();
  const result = equivalent(ir.finish(b), {
    memory: [{ base: 0x1000n, bytes: new Uint8Array(4), writable: false }],
  });
  assert.equal(result.original.status, 'memory_fault');
  assert.equal(
    result.optimized.blocks[0]!.instructions.filter((node) => node.kind === 'store').length,
    2,
  );
});

test('partial call clobber keeps unaffected slices and preserves structural call origins', () => {
  const ir = builder('ssa-partial-call');
  const b = ir.block('entry');
  const low = { ...r, id: 'low-cell', width_bits: 8, write_rule: 'preserve_other_bits' as const };
  const high = { ...low, id: 'high-cell', offset_bits: 8 };
  b.writeRegister(r, b.constant(i64, 0x1234n));
  b.call({ kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } }, [], [], {
    registers: [low],
    flags: [],
    memory: 'unknown_read_write',
  });
  b.return([b.readRegister(high)]);
  const program = ir.finish(b, [i8]);
  const call = program.blocks[0]!.instructions.find((node) => node.kind === 'call')!;
  const result = equivalent(program, {
    calls: new Map([[call.id, () => ({ results: [], writes: [] })]]),
  });
  assert.deepEqual(returned(result.original), [0x12n]);
  const transformed = result.optimized.blocks[0]!.instructions.find((node) => node.id === call.id)!;
  assert.equal(transformed.kind, 'call');
  if (transformed.kind !== 'call') return;
  assert.equal(transformed.arguments.length, 0);
  assert.equal(transformed.results.length, 0);
  assert.equal(transformed.register_outputs.length, 1);
  assert.equal(transformed.register_outputs[0]!.register.offset_bits, 0);
  assert.equal(transformed.register_outputs[0]!.register.width_bits, 8);
  assert.ok(
    instructionOperands(transformed).some(
      (value) => value.id === transformed.register_inputs[0]!.value.id,
    ),
  );
  assert.ok(
    instructionResults(transformed).some(
      (value) => value.id === transformed.register_outputs[0]!.value.id,
    ),
  );
});

test('unknown calls keep empty formal signatures, final pre-call state, and conservative memory barriers', () => {
  const ir = builder('ssa-unknown-call');
  const b = ir.block('entry');
  b.writeRegister(r, b.constant(i64, 77n));
  b.call({ kind: 'indirect', value: b.constant(i64, 0x2000n) }, [], [], {
    registers: [r],
    flags: [],
    memory: 'unknown_read_write',
  });
  b.writeRegister(r, b.constant(i64, 88n));
  b.return();
  const result = equivalent(ir.finish(b));
  assert.equal(result.original.status, 'unknown');
  assert.equal(result.original.registers.get(r.root)!.bits, 77n);
  const call = result.optimized.blocks[0]!.instructions.find((node) => node.kind === 'call')!;
  assert.ok(call.kind === 'call' && call.arguments.length === 0 && call.results.length === 0);
  assert.deepEqual(summarizeEffect(call), {
    node: call.id,
    reads_memory: true,
    writes_memory: true,
    barrier: true,
    may_stop: true,
  });
});

test('call memory writes prohibit stale load propagation, even with discarded formal results', () => {
  const ir = builder('ssa-call-memory');
  const b = ir.block('entry');
  const address = b.constant(i64, 0x1000n);
  b.store(address, b.constant(i32, 11n));
  b.load(i32, address);
  b.call({ kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } }, [], [], {
    registers: [],
    flags: [],
    memory: 'unknown_read_write',
  });
  b.return([b.load(i32, address)]);
  const program = ir.finish(b, [i32]);
  const call = program.blocks[0]!.instructions.find((node) => node.kind === 'call')!;
  const result = equivalent(program, {
    memory: [{ base: 0x1000n, bytes: new Uint8Array(4), writable: true }],
    calls: new Map([
      [call.id, () => ({ results: [], writes: [{ address: 0x1000n, width: 32, bits: 42n }] })],
    ]),
  });
  assert.deepEqual(returned(result.original), [42n]);
  assert.equal(
    result.optimized.blocks[0]!.instructions.filter((node) => node.kind === 'load').length,
    2,
  );
});

test('unknown instruction cannot become dead code, pure call cannot become a no-op', () => {
  const ir = builder('ssa-unknown-effect');
  const b = ir.block('entry');
  b.writeRegister(r, b.constant(i64, 12n));
  b.unknown('Unsupported semantic operation', {
    registers: [r],
    flags: [],
    memory: 'unknown_read_write',
  });
  b.return();
  const result = equivalent(ir.finish(b));
  assert.equal(result.original.status, 'unknown');
  assert.equal(
    result.optimized.blocks[0]!.instructions.filter((node) => node.kind === 'unknown_effect')
      .length,
    1,
  );
  const pure = builder('ssa-pure-call');
  const c = pure.block('entry');
  c.call(
    { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
    [],
    [],
    { registers: [], flags: [], memory: 'none' },
    [`evidence_${'c'.repeat(64)}`],
  );
  c.return();
  assert.ok(
    forms(pure.finish(c)).optimized.blocks[0]!.instructions.some((node) => node.kind === 'call'),
  );
});
