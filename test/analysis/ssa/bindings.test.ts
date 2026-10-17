import assert from 'node:assert/strict';
import test from 'node:test';
import { integer, verifyIR } from '../../../src/ir/index.js';
import { builder, image, register, returned } from '../../ir/support.js';
import { equivalent, forms } from './support.js';

const i32 = integer(32),
  i64 = integer(64);
const root = register('binding-root', 64, 0, 'replace_root', 'binding-state');

test('binding verifier rejects missing states, overlapping slices, missing exits and boundary inputs', () => {
  const ir = builder('ssa-binding-invariants');
  const b = ir.block('entry');
  b.writeRegister(root, b.constant(i64, 9n));
  b.load(i32, b.constant(i64, 0x1000n));
  b.return();
  const { ssa } = forms(ir.finish(b));
  const row = ssa.register_states[0]!;
  assert.ok(verifyIR({ ...ssa, register_states: [] }).length > 0);
  assert.ok(
    verifyIR({ ...ssa, register_states: [{ ...row, entry: [...row.entry, row.entry[0]!] }] })
      .length > 0,
  );
  assert.ok(verifyIR({ ...ssa, register_states: [{ ...row, exit: [] }] }).length > 0);
  const missingInput = {
    ...ssa,
    blocks: ssa.blocks.map((block) => ({
      ...block,
      instructions: block.instructions.map((node) =>
        node.kind === 'load' ? { ...node, register_inputs: [] } : node,
      ),
    })),
  };
  assert.ok(verifyIR(missingInput).length > 0);
});

test('clobber bindings require exact slice coverage and fresh values', () => {
  const ir = builder('ssa-output-invariants');
  const b = ir.block('entry');
  b.writeRegister(root, b.constant(i64, 9n));
  b.call({ kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } }, [], [], {
    registers: [root],
    flags: [],
    memory: 'unknown_read_write',
  });
  b.return();
  const { ssa } = forms(ir.finish(b));
  const missingOutput = {
    ...ssa,
    blocks: ssa.blocks.map((block) => ({
      ...block,
      instructions: block.instructions.map((node) =>
        node.kind === 'call' ? { ...node, register_outputs: [] } : node,
      ),
    })),
  };
  assert.ok(verifyIR(missingOutput).length > 0);
  const reusedInput = {
    ...ssa,
    blocks: ssa.blocks.map((block) => ({
      ...block,
      instructions: block.instructions.map((node) =>
        node.kind === 'call' ? { ...node, register_outputs: node.register_inputs } : node,
      ),
    })),
  };
  assert.ok(verifyIR(reusedInput).length > 0);
});

test('oracle physical argument/return state preserves zero invented formal arity', () => {
  const ir = builder('ssa-call-physical-state');
  const b = ir.block('entry');
  b.writeRegister(root, b.constant(i64, 40n));
  b.call({ kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } }, [], [], {
    registers: [root],
    flags: [],
    memory: 'unknown_read_write',
  });
  b.return([b.readRegister(root)]);
  const program = ir.finish(b, [i64]);
  const call = program.blocks[0]!.instructions.find((node) => node.kind === 'call')!;
  const result = equivalent(program, {
    calls: new Map([
      [
        call.id,
        (input) => {
          assert.equal(input.arguments.length, 0);
          return {
            results: [],
            writes: [],
            register_writes: [{ register: root, bits: input.readRegister(root) + 2n }],
          };
        },
      ],
    ]),
  });
  assert.deepEqual(returned(result.original), [42n]);
});

test('large architectural clobber roots are partitioned into supported integer cells', () => {
  const ir = builder('ssa-large-register-root');
  const b = ir.block('entry');
  const large = register('large-opaque', 8192, 0, 'replace_root', 'large-opaque-state', 8192);
  b.unknown('Unsupported large-register operation', {
    registers: [large],
    flags: [],
    memory: 'none',
  });
  b.return();
  const result = equivalent(ir.finish(b));
  assert.equal(result.ssa.register_states[0]!.entry.length, 4);
  assert.ok(
    result.ssa.register_states[0]!.entry.every(
      (binding) => binding.value.type.kind === 'integer' && binding.value.type.bits === 2048,
    ),
  );
});

test('assembling low unknown and high undefined cells preserves undefined dominance', () => {
  const ir = builder('ssa-slice-undefined-priority');
  const b = ir.block('entry');
  const whole = register('whole', 16, 0, 'replace_root', 'mixed-state', 16);
  const high = {
    ...whole,
    id: 'high',
    offset_bits: 8,
    width_bits: 8,
    write_rule: 'preserve_other_bits' as const,
  };
  b.writeRegister(
    high,
    b.indeterminate(integer(8), 'undefined', 'Undefined architectural high bits'),
  );
  b.return([b.readRegister(whole)]);
  const result = equivalent(ir.finish(b, [integer(16)]));
  assert.equal(result.original.status, 'undefined');
  assert.ok(
    result.ssa.blocks[0]!.instructions.some(
      (node) => node.kind === 'assign' && node.expression.kind === 'concat',
    ),
  );
});

test('mixed-width concatenation and split register reads use low-bits-first ordering', () => {
  const ir = builder('ssa-mixed-width-concat');
  const b = ir.block('entry');
  const whole = register('whole', 16, 0, 'replace_root', 'mixed-width', 16);
  const middle = {
    ...whole,
    id: 'middle',
    offset_bits: 3,
    width_bits: 5,
    write_rule: 'preserve_other_bits' as const,
  };
  b.writeRegister(whole, b.constant(integer(16), 0xab05n));
  b.writeRegister(middle, b.constant(integer(5), 17n));
  const joined = b.concat([
    b.constant(integer(3), 5n),
    b.constant(integer(5), 17n),
    b.constant(integer(8), 0xabn),
  ]);
  b.return([b.readRegister(whole), joined]);
  assert.deepEqual(returned(equivalent(ir.finish(b, [integer(16), integer(16)])).original), [
    0xab8dn,
    0xab8dn,
  ]);
});

test('architectural roles come from descriptors rather than register-name patterns', () => {
  const ir = builder('ssa-opaque-stack-role');
  const b = ir.block('entry');
  const generalView = register('ordinary-view', 32, 0, 'preserve_other_bits', 'not-an-sp-spelling');
  const stack = {
    ...register('stack-view', 64, 0, 'replace_root', generalView.root),
    role: 'stack_pointer' as const,
  };
  b.readRegister(generalView);
  b.writeRegister(stack, b.constant(i64, 0x1000n));
  b.return();
  const result = equivalent(ir.finish(b));
  assert.ok(
    result.ssa.register_states[0]!.entry.every(
      (binding) => binding.register.role === 'stack_pointer',
    ),
  );
});
