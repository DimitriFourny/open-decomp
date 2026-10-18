import assert from 'node:assert/strict';
import test from 'node:test';
import { sysvAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { simplifySSA } from '../../src/analysis/values/index.js';
import { integer, type SSAForm } from '../../src/ir/index.js';
import { builder, register } from '../ir/support.js';
import { emit, execute } from '../emitters/c/support.js';

const u8 = integer(8),
  u32 = integer(32),
  u64 = integer(64);
const mask64 = (1n << 64n) - 1n;
const source = { abi: sysvAMD64Abi, callees: [], addresses: [] };
const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
const rsi = register('rsi', 64, 0, 'replace_root', 'x86_64:rsi');
const rax = register('rax', 64, 0, 'replace_root', 'x86_64:rax');
const rcx = register('rcx', 64, 0, 'replace_root', 'x86_64:rcx');
const ecx = register('ecx', 32, 0, 'zero_extend_root', 'x86_64:rcx');
const cl = register('cl', 8, 0, 'preserve_other_bits', 'x86_64:rcx');
const rdx = register('rdx', 64, 0, 'replace_root', 'x86_64:rdx');

function ssa(ir: Parameters<typeof constructSSA>[0]): SSAForm {
  const constructed = constructSSA(ir);
  assert.equal(constructed.value.form, 'ssa');
  const simplified = simplifySSA(constructed.value as SSAForm);
  assert.equal(simplified.state, 'complete');
  return simplified.value;
}

/** Run one emitted body on physical entry registers; nothing analyzed executes. */
function run(
  ir: SSAForm,
  emission: Parameters<typeof execute>[0],
  roots: ReadonlyMap<string, bigint>,
): bigint {
  const entry = ir.blocks.find((block) => block.id === ir.entry)!;
  const bindings = ir.register_states.find((state) => state.block === ir.entry)!.entry;
  const inputs = new Map(entry.parameters.map((value) => [value.id, 0n]));
  for (const binding of bindings)
    inputs.set(
      binding.value.id,
      BigInt.asUintN(
        binding.register.width_bits,
        (roots.get(binding.register.root) ?? 0n) >> BigInt(binding.register.offset_bits),
      ),
    );
  const observed = execute(emission, inputs);
  assert.equal(observed.exit, 'machine_return', emission.text);
  assert.equal(observed.values.length, 1, emission.text);
  return observed.values[0]!;
}

function recombinations(emission: Parameters<typeof execute>[0]): number {
  return (emission.local_validation ?? []).filter(
    (record) => record.rule === 'register_cell_recombination',
  ).length;
}

/** `bit` is a 64-bit loop variable entered through a 32-bit immediate write
 * (which clears its upper cell) and repeated through a 64-bit left shift that
 * carries it into, and out of, the upper cell. */
function shiftLoop(): SSAForm {
  const b = builder('source-loop-cells-shift'),
    entry = b.block('entry'),
    loop = b.block('loop'),
    body = b.block('body'),
    exit = b.block('exit');
  entry.writeRegister(rax, entry.constant(u64, 0n));
  entry.writeRegister(ecx, entry.constant(u32, 0x80000000n));
  entry.jump(loop);
  const bit = loop.readRegister(rcx);
  loop.branch(loop.compare('eq', bit, loop.constant(u64, 0n)), loop.edge(exit), loop.edge(body));
  const current = body.readRegister(rcx),
    mask = body.readRegister(rdi),
    total = body.readRegister(rax);
  const scaled = body.int('mul', total, body.constant(u64, 3n));
  body.writeRegister(rax, body.int('add', scaled, body.int('and', current, mask)));
  body.writeRegister(rcx, body.int('shl', current, body.constant(u64, 1n)));
  body.jump(loop);
  exit.return([exit.readRegister(rax)]);
  return ssa(b.finish(entry, [u64]));
}
const shiftOracle = (mask: bigint): bigint => {
  let total = 0n;
  for (let bit = 0x80000000n; bit; bit = (bit << 1n) & mask64)
    total = (total * 3n + (bit & mask)) & mask64;
  return total;
};

/** CRC-style byte lanes: `ecx` is written whole (clearing bits 32..63), its low
 * byte is tested separately, and the loop reads all 32 bits together. */
function laneLoop(): SSAForm {
  const b = builder('source-loop-cells-lanes'),
    entry = b.block('entry'),
    loop = b.block('loop'),
    body = b.block('body'),
    exit = b.block('exit');
  entry.writeRegister(ecx, entry.cast('truncate', u32, entry.readRegister(rdi)));
  entry.writeRegister(rdx, entry.readRegister(rsi));
  entry.jump(loop);
  const count = loop.readRegister(rdx);
  loop.branch(loop.compare('eq', count, loop.constant(u64, 0n)), loop.edge(exit), loop.edge(body));
  const word = body.readRegister(ecx),
    low = body.readRegister(cl);
  const half = body.int('lshr', word, body.constant(u32, 1n));
  const odd = body.compare(
    'ne',
    body.int('and', low, body.constant(u8, 1n)),
    body.constant(u8, 0n),
  );
  body.writeRegister(
    ecx,
    body.select(odd, body.int('xor', half, body.constant(u32, 0xedb88320n)), half),
  );
  body.writeRegister(rdx, body.int('sub', body.readRegister(rdx), body.constant(u64, 1n)));
  body.jump(loop);
  exit.return([exit.readRegister(ecx)]);
  return ssa(b.finish(entry, [u32]));
}
const laneOracle = (crc: bigint, count: bigint): bigint => {
  let value = crc & 0xffffffffn;
  for (let index = 0n; index < count; index++)
    value = value & 1n ? (value >> 1n) ^ 0xedb88320n : value >> 1n;
  return value;
};

/** Refusal: the two 32-bit halves of one root are written by independent
 * partial writes that each preserve the other half, though the loop reads
 * the 64-bit register as a whole. */
const low32 = register('rdx.low', 32, 0, 'preserve_other_bits', 'x86_64:rdx');
const high32 = register('rdx.high', 32, 32, 'preserve_other_bits', 'x86_64:rdx');
function independentLoop(): SSAForm {
  const b = builder('source-loop-cells-independent'),
    entry = b.block('entry'),
    loop = b.block('loop'),
    body = b.block('body'),
    exit = b.block('exit');
  entry.writeRegister(rdx, entry.readRegister(rdi));
  entry.writeRegister(rax, entry.constant(u64, 0n));
  entry.writeRegister(rcx, entry.readRegister(rsi));
  entry.jump(loop);
  const count = loop.readRegister(rcx);
  loop.branch(loop.compare('eq', count, loop.constant(u64, 0n)), loop.edge(exit), loop.edge(body));
  const whole = body.readRegister(rdx),
    total = body.readRegister(rax);
  body.writeRegister(rax, body.int('xor', body.int('mul', total, body.constant(u64, 5n)), whole));
  body.writeRegister(
    low32,
    body.int('add', body.readRegister(low32), body.constant(u32, 0xfffffff0n)),
  );
  body.writeRegister(high32, body.int('add', body.readRegister(high32), body.constant(u32, 3n)));
  body.writeRegister(rcx, body.int('sub', count, body.constant(u64, 1n)));
  body.jump(loop);
  exit.return([exit.readRegister(rax)]);
  return ssa(b.finish(entry, [u64]));
}
const independentOracle = (start: bigint, count: bigint): bigint => {
  let total = 0n,
    low = start & 0xffffffffn,
    high = start >> 32n;
  for (let index = 0n; index < count; index++) {
    total = ((total * 5n) & mask64) ^ (low | (high << 32n));
    low = (low + 0xfffffff0n) & 0xffffffffn;
    high = (high + 3n) & 0xffffffffn;
  }
  return total;
};

for (const language of ['c-like', 'python-like'] as const) {
  test(`${language} loop-carried 64-bit cells entered by a 32-bit constant write print as one variable`, () => {
    const ir = shiftLoop();
    const output = emit(ir, { source }, language).emission;
    assert.doesNotMatch(output.text, /<< 32/, output.text);
    assert.ok(recombinations(output) > 0);
    const checked = emit(ir, { source }, language, 'checked').emission;
    assert.equal(recombinations(checked), 0);
    for (const mask of [0n, 1n, 0x80000000n, 0xffffffffn, 0x123456789abcdef0n, mask64])
      for (const emission of [output, checked])
        assert.equal(
          run(ir, emission, new Map([['x86_64:rdi', mask]])),
          shiftOracle(mask),
          emission.text,
        );
  });

  test(`${language} loop-carried byte and 24-bit lanes read together print as one 32-bit variable`, () => {
    const ir = laneLoop();
    const output = emit(ir, { source }, language).emission;
    assert.doesNotMatch(output.text, /<< 8\b/, output.text);
    assert.doesNotMatch(output.text, /0xffffff\b/, output.text);
    assert.ok(recombinations(output) > 0);
    for (const [crc, count] of [
      [0n, 0n],
      [1n, 1n],
      [0xffffffffn, 8n],
      [0x1234567890abcdefn, 33n],
    ] as const)
      for (const emission of [output, emit(ir, { source }, language, 'checked').emission])
        assert.equal(
          run(
            ir,
            emission,
            new Map([
              ['x86_64:rdi', crc],
              ['x86_64:rsi', count],
            ]),
          ),
          laneOracle(crc, count),
          emission.text,
        );
  });

  test(`${language} independently written halves of one register stay separate`, () => {
    const ir = independentLoop();
    const output = emit(ir, { source }, language).emission;
    // The halves keep their own loop variables and the read rejoins them.
    assert.match(output.text, /<< 32/, output.text);
    for (const [start, count] of [
      [0n, 0n],
      [0x100000020n, 3n],
      [0xfffffffffffffff0n, 5n],
    ] as const)
      for (const emission of [output, emit(ir, { source }, language, 'checked').emission])
        assert.equal(
          run(
            ir,
            emission,
            new Map([
              ['x86_64:rdi', start],
              ['x86_64:rsi', count],
            ]),
          ),
          independentOracle(start, count),
          emission.text,
        );
  });
}
