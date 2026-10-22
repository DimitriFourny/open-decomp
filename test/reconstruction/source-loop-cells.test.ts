import assert from 'node:assert/strict';
import test from 'node:test';
import { darwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { simplifySSA } from '../../src/analysis/values/index.js';
import type { AbiProfile, AbiType, RegisterDescriptor } from '../../src/core/index.js';
import { integer, type SSAForm, type Value } from '../../src/ir/index.js';
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

function rule(emission: Parameters<typeof execute>[0], name: string): number {
  return (emission.local_validation ?? []).filter((record) => record.rule === name).length;
}

/** `matrix_switch(sel, a, b)` as lifted machine code with no explicit IR
 * result: nine arms return 64-bit values from the integer result register; arm
 * 9 joins the default (`return a`) at one return through a 32-bit write of 99
 * (which clears the upper cell) and a 64-bit conditional move of 42. With
 * `narrow`, every exit writes only the 32-bit view (the default returns `(u32)a`
 * and arm 9 selects between 32-bit values). */
function switchJoin(abi: AbiProfile, narrow: boolean): { ir: SSAForm; roots: string[] } {
  const word: AbiType = { kind: 'integer', bits: 64, signed: false };
  const layout = abi.classifyCall({
    returns: word,
    parameters: [word, word, word],
    variadic: false,
    fixed_parameter_count: 3,
  });
  const descriptor = (
    location: (typeof layout.returns)[number] | undefined,
  ): RegisterDescriptor => {
    assert.equal(location?.kind, 'register');
    if (location?.kind !== 'register') throw new Error('register location required');
    return location.register;
  };
  const [selector, left, right] = layout.parameters.map((parameter) =>
    descriptor(parameter.locations[0]),
  ) as [RegisterDescriptor, RegisterDescriptor, RegisterDescriptor];
  const result = descriptor(layout.returns[0]);
  const low = register(`${result.root}:0:32`, 32, 0, 'zero_extend_root', result.root);
  const b = builder(`source-join-exit-${abi.id}-${narrow}`),
    entry = b.block('entry'),
    done = b.block('done'),
    join = b.block('join');
  const sel = entry.cast('truncate', u32, entry.readRegister(selector));
  const a = entry.readRegister(left);
  if (narrow) entry.writeRegister(low, entry.cast('truncate', u32, a));
  else entry.writeRegister(result, a);
  const arms = Array.from({ length: 9 }, (_, index) => b.block(`arm${index}`));
  entry.terminate({
    kind: 'switch',
    value: sel,
    cases: [
      ...arms.map((arm, index) => ({ bits: BigInt(index), edge: entry.edge(arm) })),
      { bits: 9n, edge: entry.edge(join) },
    ],
    otherwise: entry.edge(done),
  });
  // `c` makes a constant of the arm's width; `shift` is that width minus one.
  const shift = narrow ? 31n : 63n;
  const operations: ((
    block: (typeof arms)[number],
    x: Value,
    y: Value,
    c: (bits: bigint) => Value,
  ) => Value)[] = [
    (k, x, y) => k.int('add', x, y),
    (k, x, y) => k.int('xor', x, y),
    (k, x, y, c) => k.int('add', k.int('mul', x, c(3n)), y),
    (k, x, y) => k.int('sub', x, y),
    (k, x, y, c) => k.int('or', k.int('shl', x, k.int('and', y, c(shift))), c(1n)),
    (k, x, y) => k.int('and', x, y),
    (k, x, y) => k.int('or', x, y),
    (k, x, y, c) => k.int('add', k.int('lshr', x, k.int('and', y, c(shift))), y),
    (k, x, y, c) => k.int('xor', k.int('add', x, c(17n)), k.int('mul', y, c(9n))),
  ];
  arms.forEach((arm, index) => {
    const x = narrow ? arm.readRegister(low) : arm.readRegister(result),
      y = arm.readRegister(right);
    const value = operations[index]!(arm, x, narrow ? arm.cast('truncate', u32, y) : y, (bits) =>
      arm.constant(narrow ? u32 : u64, bits),
    );
    arm.writeRegister(narrow ? low : result, value);
    arm.return([]);
  });
  if (narrow) {
    const equal = join.compare(
      'eq',
      join.readRegister(low),
      join.cast('truncate', u32, join.readRegister(right)),
    );
    join.writeRegister(low, join.select(equal, join.constant(u32, 42n), join.constant(u32, 99n)));
  } else {
    const equal = join.compare('eq', join.readRegister(result), join.readRegister(right));
    join.writeRegister(low, join.constant(u32, 99n));
    join.writeRegister(
      result,
      join.select(equal, join.constant(u64, 42n), join.readRegister(result)),
    );
  }
  join.jump(done);
  done.return([]);
  return {
    ir: ssa(b.finish(entry, [])),
    roots: [selector.root, left.root, right.root, result.root],
  };
}
const switchOracle = (sel: bigint, a: bigint, b: bigint, narrow: boolean): bigint => {
  const mask = narrow ? 0xffffffffn : mask64;
  [a, b] = [a & mask, b & mask];
  const width = narrow ? 32n : 64n;
  const results = [
    a + b,
    a ^ b,
    a * 3n + b,
    a - b,
    (a << (b & (width - 1n))) | 1n,
    a & b,
    a | b,
    (a >> (b & (width - 1n))) + b,
    (a + 17n) ^ (b * 9n),
    a === b ? 42n : 99n,
  ];
  return BigInt.asUintN(Number(width), results[Number(sel & 0xffffffffn)] ?? a);
};
/** The returned integer register: the explicit result with any physical
 * overlay of its root (the checked view keeps the upper cell as one). */
function returnedRoot(
  ir: SSAForm,
  emission: Parameters<typeof execute>[0],
  roots: ReadonlyMap<string, bigint>,
  root: string,
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
  const overlay = observed.registers.get(root) ?? { bits: 0n, known: 0n };
  return (observed.values[0]! & ~overlay.known) | (overlay.bits & overlay.known);
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

  for (const abi of [sysvAMD64Abi, darwinArm64Abi])
    for (const narrow of [false, true])
      test(`${language} ${abi.id} ${narrow ? 'all-narrow exits keep the narrow result type' : 'a join of a 32-bit write and 64-bit results returns the whole register'}`, () => {
        const { ir, roots } = switchJoin(abi, narrow);
        const [selector, left, right, result] = roots as [string, string, string, string];
        const output = emit(ir, { source: { abi, callees: [], addresses: [] } }, language).emission;
        const checked = emit(
          ir,
          { source: { abi, callees: [], addresses: [] } },
          language,
          'checked',
        ).emission;
        const type = narrow ? 'uint32_t' : 'uint64_t';
        assert.match(
          output.text,
          language === 'c-like' ? new RegExp(`^${type} fn_`, 'm') : new RegExp(`-> ${type}:`),
          output.text,
        );
        assert.doesNotMatch(output.text, /physical_return/, output.text);
        assert.equal(rule(output, 'exit_result_width'), narrow ? 0 : 1);
        if (!narrow) {
          assert.ok(recombinations(output) > 0, output.text);
          // The checked view keeps the exact upper cell as a machine overlay.
          assert.match(checked.text, /physical_return/, checked.text);
        }
        assert.equal(rule(checked, 'exit_result_width'), 0);
        assert.equal(recombinations(checked), 0);
        // Callers pass values of the formal types: the selector is 32-bit, and
        // so are `a` and `b` when every exit is narrow.
        const mask = narrow ? 0xffffffffn : mask64;
        const a = 0x123456789abcdef0n & mask;
        for (const [sel, b] of [
          ...Array.from({ length: 9 }, (_, index) => [BigInt(index), 0x0fedcba987654321n & mask]),
          [9n, a],
          [9n, (a ^ (1n << 40n)) & mask],
          [9n, 7n],
          [10n, 5n],
          [0xffffffffn, 5n],
        ] as const)
          for (const emission of [output, checked])
            assert.equal(
              returnedRoot(
                ir,
                emission,
                new Map([
                  [selector, sel],
                  [left, a],
                  [right, b],
                ]),
                result,
              ) & mask,
              switchOracle(sel, a, b, narrow),
              emission.text,
            );
      });
}
