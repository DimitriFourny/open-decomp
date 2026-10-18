import assert from 'node:assert/strict';
import test from 'node:test';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { integer, type SSAForm } from '../../../src/ir/index.js';
import { builder, image, register } from '../../ir/support.js';
import { emit, execute } from './support.js';

const i8 = integer(8),
  i64 = integer(64);
const source = { abi: sysvAMD64Abi, callees: [], addresses: [] };
const clobbers = {
  registers: [register('rax', 64, 0, 'replace_root', 'x86_64:rax')],
  flags: [register('cf', 1, 0, 'preserve_other_bits', 'x86_64:rflags')],
  memory: 'unknown_read_write' as const,
};
const contract = {
  memory: 'unknown_read_write',
  registers: ['x86_64:rax:0:64'],
  flags: ['x86_64:rflags:0:1'],
};

for (const language of ['c-like', 'python-like'] as const) {
  test(`${language} compact unknown effects retain contracts, inputs and ordering`, () => {
    const b = builder(`compact-effects-${language}`),
      block = b.block('entry'),
      address = block.constant(i64, 0x1000n);
    block.store(address, block.constant(i8, 7n));
    block.writeRegister(
      clobbers.registers[0]!,
      block.cast('zero_extend', i64, block.load(i8, address)),
    );
    block.unknown('unsupported instruction', clobbers);
    block.store(address, block.constant(i8, 99n));
    block.return();
    const ir = constructSSA(b.finish(block)).value as SSAForm;
    const output = emit(ir, { source }, language).emission;
    assert.match(output.text, /__unknown_effect\("unsupported instruction", physical_inputs\(/);
    assert.doesNotMatch(output.text, /boundary\(|opaque_effect\(/);
    const record = output.local_validation?.find((item) => item.rule === 'compact_unknown_effect');
    assert.equal(record?.status, 'verified');
    assert.deepEqual(JSON.parse(record!.reason!), contract);
    const unknown = ir.blocks
      .flatMap((block) => block.instructions)
      .find((node) => node.kind === 'unknown_effect')!;
    assert.ok(unknown.kind === 'unknown_effect');
    assert.deepEqual(
      new Set(record?.subject_ids),
      new Set([unknown.id, unknown.effect_in.id, unknown.effect_out.id]),
    );
    const checked = emit(ir, { source }, language, 'checked').emission;
    assert.match(checked.text, /opaque_effect\(/);
    assert.match(checked.text, /boundary\("unknown_read_write"/);
    for (const emission of [output, checked]) {
      const result = execute(emission, new Map(), new Map([[0x1000n, 0]]));
      assert.equal(result.exit, 'unknown');
      assert.deepEqual(result.events, ['store', 'load', 'unknown']);
      assert.equal(result.memory.get(0x1000n), 7);
      const fault = execute(emission, new Map(), new Map());
      assert.equal(fault.exit, 'fault');
      assert.deepEqual(fault.events, ['store']);
    }
  });

  test(`${language} a visible call carries its own effect contract, never a neighboring unknown effect`, () => {
    const b = builder(`call-effects-${language}`),
      block = b.block('entry'),
      address = block.constant(i64, 0x1000n);
    block.store(address, block.constant(i8, 7n));
    block.call(
      { kind: 'direct', address: { image_id: image, space: 'va', value: 0x4000n } },
      [block.load(i8, address)],
      [],
      clobbers,
    );
    block.store(address, block.constant(i8, 9n));
    block.unknown('separate unsupported instruction', clobbers);
    block.store(address, block.constant(i8, 99n));
    block.return();
    const ir = constructSSA(b.finish(block)).value as SSAForm;
    const output = emit(ir, { source }, language).emission;
    assert.doesNotMatch(output.text, /boundary\(/);
    assert.match(output.text, /__unknown_effect\("separate unsupported instruction"/);
    const record = output.local_validation?.find((item) => item.rule === 'call_effects');
    assert.equal(record?.status, 'verified');
    assert.deepEqual(JSON.parse(record!.reason!), contract);
    const result = execute(
      output,
      new Map(),
      new Map([[0x1000n, 0]]),
      1n,
      new Map(),
      new Map(),
      new Map([['sub_4000', () => []]]),
    );
    assert.equal(result.exit, 'unknown');
    assert.deepEqual(result.events, ['store', 'load', 'call', 'store', 'unknown']);
    assert.equal(result.memory.get(0x1000n), 9);
  });

  test(`${language} exhausted presentation capacity retains explicit unknown and call contracts`, () => {
    const b = builder(`bounded-effects-${language}`),
      block = b.block('entry');
    const registers = Array.from({ length: 9 }, (_, index) =>
      register(`scratch${index}`, 64, 0, 'replace_root', `x86_64:scratch${index}`),
    );
    for (let index = 0; index < 270; index++)
      block.unknown(`unsupported ${index}`, {
        ...clobbers,
        registers: registers.filter((_, bit) => ((index + 1) & (1 << bit)) !== 0),
      });
    block.call(
      { kind: 'direct', address: { image_id: image, space: 'va', value: 0x4000n } },
      [],
      [],
      clobbers,
    );
    block.return();
    const output = emit(
      constructSSA(b.finish(block)).value as SSAForm,
      { source },
      language,
    ).emission;
    assert.match(output.text, /__unknown_effect\(/);
    assert.match(output.text, /opaque_effect\("unsupported 269"/);
    assert.match(output.text, /\n\s+boundary\("unknown_read_write"/);
    assert.ok(output.local_validation?.some((item) => item.status === 'unverified'));
    assert.equal(output.local_validation?.filter((item) => item.rule === 'call_effects').length, 0);
    assert.deepEqual(execute(output, new Map()).events, ['unknown']);
  });

  test(`${language} oversized effect metadata retains the full explicit contract`, () => {
    const b = builder(`oversized-effects-${language}`),
      block = b.block('entry');
    const registers = Array.from({ length: 160 }, (_, index) =>
      register(`reg${index}`, 64, 0, 'replace_root', `x86_64:${'register'.repeat(8)}${index}`),
    );
    block.unknown('large physical contract', { ...clobbers, registers });
    block.return();
    const output = emit(constructSSA(b.finish(block)).value as SSAForm, {}, language).emission;
    assert.match(output.text, /opaque_effect\("large physical contract"/);
    assert.doesNotMatch(output.text, /__unknown_effect\(/);
    assert.ok(output.text.includes(`${registers.at(-1)!.root}:0:64`));
    assert.ok(!output.local_validation?.some((item) => item.rule === 'compact_unknown_effect'));
    assert.deepEqual(execute(output).events, ['unknown']);
  });
}
