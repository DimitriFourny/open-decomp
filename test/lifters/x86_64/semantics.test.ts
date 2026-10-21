import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bitsFloat, floatBits, verifyIR } from '../../../src/ir/index.js';
import { liftBytes, machineRegisters, register, run } from './helpers.js';
import { gpr } from '../../../src/lifters/x86_64/semantics.js';

test('real decoded AL/AH/AX writes preserve unaffected bits; EAX clears upper RAX', () => {
  for (const [code, expected] of [
    ['b0 aa', 0x11223344556677aan],
    ['b4 aa', 0x112233445566aa88n],
    ['66 b8 aa bb', 0x112233445566bbaan],
    ['b8 aa bb cc dd', 0xddcc_bbaan],
  ] as const) {
    const { ir } = liftBytes(`${code} c3`);
    assert.equal(register(run(ir, { rax: 0x1122334455667788n }), 'rax'), expected);
  }
  const { ir } = liftBytes('b0 34 b4 12 66 89 c1 b8 78 56 34 12 48 89 c2 c3');
  const result = run(ir, { rax: -1n, rcx: 0x12340000n });
  assert.equal(register(result, 'rcx'), 0x12341234n);
  assert.equal(register(result, 'rdx'), 0x12345678n);
});

test('ADD/ADC/SBB carry, signed overflow, auxiliary carry and INC carry preservation', () => {
  const add = liftBytes('04 01 c3').ir;
  let result = run(add, { rax: 0x7fn });
  assert.equal(register(result, 'rax', 8), 0x80n);
  assert.equal(register(result, 'rflags', 1, 11), 1n);
  assert.equal(register(result, 'rflags', 1), 0n);
  assert.equal(register(result, 'rflags', 1, 4), 1n);
  result = run(add, { rax: 0xffn });
  assert.equal(register(result, 'rflags', 1), 1n);
  assert.equal(register(result, 'rflags', 1, 6), 1n);
  assert.equal(register(result, 'rflags', 1, 2), 1n);
  const adc = liftBytes('14 00 c3').ir;
  assert.equal(register(run(adc, { rax: 0xffn, rflags: 1n }), 'rax', 8), 0n);
  const sbb = liftBytes('1c 00 c3').ir;
  result = run(sbb, { rax: 0n, rflags: 1n });
  assert.equal(register(result, 'rax', 8), 255n);
  assert.equal(register(result, 'rflags', 1), 1n);
  const inc = liftBytes('ff c0 c3').ir;
  assert.equal(register(run(inc, { rax: 0xffffffffn, rflags: 1n }), 'rflags', 1), 1n);
});

for (const [code, width, operation] of [
  ['48 d3 e0', 64, 'shl'],
  ['d3 e8', 32, 'shr'],
  ['d2 f8', 8, 'sar'],
  ['66 d3 c0', 16, 'rol'],
] as const) {
  test(`${operation}${width} masks counts and preserves flags at zero`, () => {
    const { ir } = liftBytes(`${code} c3`),
      value = (1n << BigInt(width - 1)) | 3n;
    for (const count of [0, 1, width - 1, width, width + 1, 31, 32, 63, 64, 65, 255]) {
      const masked = count & (width === 64 ? 63 : 31),
        rotated = masked % width;
      const expected =
        operation === 'shl'
          ? value << BigInt(masked)
          : operation === 'shr'
            ? value >> BigInt(masked)
            : operation === 'sar'
              ? BigInt.asIntN(width, value) >> BigInt(masked)
              : (value << BigInt(rotated)) | (value >> BigInt(width - rotated));
      const result = run(ir, { rax: value, rcx: BigInt(count), rflags: 0x8d5n });
      assert.equal(
        register(result, 'rax', width),
        BigInt.asUintN(width, expected),
        `count=${count}`,
      );
      if (masked === 0) assert.equal(register(result, 'rflags', 12), 0x8d5n);
      if (operation === 'rol' && masked > 1)
        assert.equal(result.registers.get('x86_64:rflags')!.undefined & 0x800n, 0x800n);
    }
  });
}

test('MUL/IMUL implicit high halves and 8-bit AX pair', () => {
  let result = run(liftBytes('f6 e3 c3').ir, { rax: 0x80n, rbx: 2n });
  assert.equal(register(result, 'rax', 16), 256n);
  assert.equal(register(result, 'rflags', 1), 1n);
  result = run(liftBytes('48 f7 eb c3').ir, { rax: -3n, rbx: 5n });
  assert.equal(register(result, 'rax'), BigInt.asUintN(64, -15n));
  assert.equal(register(result, 'rdx'), (1n << 64n) - 1n);
  assert.equal(register(result, 'rflags', 1), 0n);
  result = run(liftBytes('0f af c3 c3').ir, { rax: 0x7fffffffn, rbx: 2n });
  assert.equal(register(result, 'rax'), 0xfffffffen);
  assert.equal(register(result, 'rflags', 1, 11), 1n);
  result = run(liftBytes('6b c3 fd c3').ir, { rbx: 7n });
  assert.equal(register(result, 'rax'), BigInt.asUintN(32, -21n));
});

test('DIV/IDIV emit #DE for zero and quotient overflow, not undefined arithmetic', () => {
  const unsigned = liftBytes('f7 f3 c3').ir;
  assert.equal(run(unsigned, { rax: 9n, rdx: 0n, rbx: 0n }).status, 'trap');
  assert.equal(run(unsigned, { rax: 0n, rdx: 1n, rbx: 1n }).status, 'trap');
  let result = run(unsigned, { rax: 20n, rdx: 0n, rbx: 3n });
  assert.equal(register(result, 'rax'), 6n);
  assert.equal(register(result, 'rdx'), 2n);
  const signed = liftBytes('99 f7 fb c3').ir;
  assert.equal(run(signed, { rax: 0x80000000n, rbx: 0xffffffffn }).status, 'trap');
  result = run(signed, { rax: BigInt.asUintN(32, -13n), rbx: 5n });
  assert.equal(register(result, 'rax'), 0xfffffffen);
  assert.equal(register(result, 'rdx'), 0xfffffffdn);
  result = run(liftBytes('f6 f3 c3').ir, { rax: 0x123n, rbx: 0x20n });
  assert.equal(register(result, 'rax', 16), 0x309n);
  const wide = liftBytes('48 f7 fb c3').ir;
  assert.equal(run(wide, { rax: 0n, rdx: 1n << 63n, rbx: -1n }).status, 'trap');
});

test('conditions use signed flags; branches and conditional memory reads are real', () => {
  const { ir } = liftBytes('39 d1 0f 4f c1 0f 9c c3 c3');
  const result = run(ir, { rax: 7n, rcx: BigInt.asUintN(32, -2n), rdx: BigInt.asUintN(32, -8n) });
  assert.equal(register(result, 'rax'), 0xfffffffen);
  assert.equal(register(result, 'rbx', 8), 0n);
  const branch = liftBytes('85 c9 74 06 b8 07 00 00 00 c3 b8 09 00 00 00 c3').ir;
  assert.equal(register(run(branch, { rcx: 0n }), 'rax'), 9n);
  assert.equal(register(run(branch, { rcx: 1n }), 'rax'), 7n);
  assert.equal(
    run(liftBytes('0f 44 01 c3').ir, { rcx: 0xdeadn, rflags: 0n }).status,
    'memory_fault',
  );
});

test('stack PUSH/POP operand order, POP RSP, and LEAVE preserve architectural SP', () => {
  let result = run(liftBytes('54 58 c3').ir);
  assert.equal(register(result, 'rax'), 0x8808n);
  assert.equal(register(result, 'rsp'), 0x8810n);
  result = run(liftBytes('68 00 89 00 00 5c c3').ir);
  assert.equal(register(result, 'rsp'), 0x8908n);
  result = run(liftBytes('55 48 89 e5 c9 c3').ir, { rbp: 0x1234n });
  assert.equal(register(result, 'rbp'), 0x1234n);
  assert.equal(register(result, 'rsp'), 0x8810n);
});

test('RIP-relative, address-size wrap and FS-base effective addresses', () => {
  let result = run(liftBytes('48 8d 05 10 00 00 00 c3').ir);
  assert.equal(register(result, 'rax'), 0x1017n);
  result = run(liftBytes('67 48 8d 04 51 c3').ir, { rcx: 0xfffffff0n, rdx: 0x10n });
  assert.equal(register(result, 'rax'), 0x10n);
  const fs = liftBytes('64 48 8b 01 c3').ir;
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(0x12345678n);
  result = run(
    fs,
    { rcx: 8n, fs_base: 0x2000n },
    { memory: [{ base: 0x2008n, bytes, writable: false }] },
  );
  assert.equal(register(result, 'rax'), 0x12345678n);
});

test('legacy scalar SSE preserves upper lanes and rejects unsupported MXCSR', () => {
  const { ir, coverage } = liftBytes('f2 0f 58 c1 f2 0f 59 c1 c3');
  const upper = 0xfeedn << 64n,
    high = 0xabcdn << 256n;
  let result = run(ir, { zmm0: high | upper | floatBits(2, 64), zmm1: floatBits(3, 64) });
  assert.equal(bitsFloat(register(result, 'zmm0', 64), 64), 15);
  assert.equal(register(result, 'zmm0', 64, 64), 0xfeedn);
  assert.equal(register(result, 'zmm0', 256, 256), 0xabcdn);
  assert.equal(coverage.state, 'partial');
  assert.ok(coverage.reasons.some((reason) => reason.includes('NaN')));
  assert.equal(result.registers.get('x86_64:mxcsr')!.known & 63n, 0n);
  for (const mxcsr of [0x3f80n, 0x9f80n, 0x1fc0n, 0n]) {
    result = run(ir, { mxcsr });
    assert.equal(result.status, 'unknown');
  }
  const move = liftBytes('f3 0f 10 01 c3').ir;
  const bytes = Buffer.alloc(4);
  bytes.writeFloatLE(4.5);
  result = run(
    move,
    { rcx: 0x2000n, zmm0: -1n },
    { memory: [{ base: 0x2000n, bytes, writable: false }] },
  );
  assert.equal(register(result, 'zmm0', 128), floatBits(4.5, 32));
  assert.equal(register(result, 'zmm0', 384, 128), (1n << 384n) - 1n);
});

test('unsupported families stay unknown, while explicit UD2 is a trap', () => {
  for (const code of ['d9 e8', 'f3 a4', 'f0 01 01', 'c5 f8 58 c1']) {
    const lifted = liftBytes(`${code} c3`);
    assert.equal(lifted.coverage.state, 'partial');
    assert.ok(
      lifted.ir.blocks.some((block) =>
        block.instructions.some((instruction) => instruction.kind === 'unknown_effect'),
      ),
    );
    assert.equal(run(lifted.ir).status, 'unknown');
  }
  assert.equal(run(liftBytes('0f 0b').ir).status, 'trap');
});

test('instruction provenance and deterministic block/value identities survive division splitting', () => {
  const first = liftBytes('99 f7 f9 c3'),
    second = liftBytes('99 f7 f9 c3');
  assert.deepEqual(first.ir, second.ir);
  assert.deepEqual(verifyIR(first.ir), []);
  const origins = new Set(first.graph.instructions.map((instruction) => instruction.id));
  for (const block of first.ir.blocks)
    for (const node of [...block.instructions, block.terminator]) {
      assert.ok(node.provenance.instruction_ids.length > 0);
      assert.ok(node.provenance.instruction_ids.every((id) => origins.has(id)));
      assert.ok(node.provenance.ranges.every((range) => range.start.space === 'file'));
    }
  assert.ok(machineRegisters(first.ir).has('x86_64:rsp'));
});

test('unknown calls retain ABI clobbers and expose real callee-entry stack without formal arguments', () => {
  const { ir } = liftBytes('ff d0 c3');
  const call = ir.blocks
    .flatMap((block) => block.instructions)
    .find((instruction) => instruction.kind === 'call');
  assert.ok(call?.kind === 'call');
  assert.deepEqual(call.arguments, []);
  assert.deepEqual(call.results, []);
  assert.equal(run(ir, { rax: 0x4000n }).status, 'unknown');
  const result = run(
    ir,
    { rax: 0x4000n },
    {
      calls: new Map([
        [
          call.id,
          (input) => {
            assert.equal(input.target, 0x4000n);
            assert.deepEqual(input.arguments, []);
            const sp = input.readRegister(gpr('rsp'));
            assert.equal(sp, 0x8800n);
            assert.equal(input.readMemory(sp, 64), 0x1002n);
            return {
              results: [],
              writes: [],
              register_writes: [{ register: gpr('rax'), bits: 42n }],
            };
          },
        ],
      ]),
    },
  );
  assert.equal(register(result, 'rax'), 42n);
  assert.equal(register(result, 'rsp'), 0x8810n);
});

test('signed extensions and false CMOV32 use architectural root write rules', () => {
  let result = run(liftBytes('48 0f be c1 c3').ir, { rcx: 0x80n });
  assert.equal(register(result, 'rax'), BigInt.asUintN(64, -128n));
  result = run(liftBytes('0f b6 c4 c3').ir, { rax: 0xffff8000n });
  assert.equal(register(result, 'rax'), 128n);
  result = run(liftBytes('0f 44 c1 c3').ir, { rax: -1n, rcx: 7n, rflags: 0n });
  assert.equal(register(result, 'rax'), 0xffffffffn);
});

test('SSE unordered compare sets CF/PF/ZF and clears OF/SF/AF', () => {
  const { ir } = liftBytes('66 0f 2e c1 c3');
  const result = run(ir, { zmm0: floatBits(Number.NaN, 64), zmm1: floatBits(1, 64), rflags: -1n });
  for (const offset of [0, 2, 6]) assert.equal(register(result, 'rflags', 1, offset), 1n);
  for (const offset of [4, 7, 11]) assert.equal(register(result, 'rflags', 1, offset), 0n);
});

test('an unsupported instruction clobbers the modeled state, then lifting continues in the same block', () => {
  // fld1 (x87) is unsupported; the following mov and ret are still lifted.
  const { ir, coverage, graph } = liftBytes('d9 e8 b8 07 00 00 00 c3');
  assert.equal(graph.blocks.length, 1);
  const entry = ir.blocks.find((block) => block.id === ir.entry)!;
  const kinds = entry.instructions.map((instruction) => instruction.kind);
  const effect = kinds.indexOf('unknown_effect');
  assert.ok(effect >= 0);
  const write = entry.instructions.findIndex(
    (instruction, index) =>
      index > effect &&
      instruction.kind === 'write_register' &&
      instruction.register.root === 'x86_64:rax',
  );
  assert.ok(write > effect, 'the mov after the unsupported instruction is lifted');
  assert.equal(entry.terminator.kind, 'return');
  const unknown = entry.instructions[effect]!;
  assert.ok(unknown.kind === 'unknown_effect' && unknown.clobbers.memory === 'unknown_read_write');
  assert.equal(coverage.state, 'partial');
  assert.equal(coverage.completed_units, graph.instructions.length - 1);
  assert.equal(run(ir).status, 'unknown');
  assert.deepEqual(verifyIR(ir), []);
});

test('lifting continues past an unsupported instruction into its conditional successors', () => {
  // test eax,eax ; fld1 ; je +1 ; ret ; ret — both returns stay reachable.
  const { ir } = liftBytes('85 c0 d9 e8 74 01 c3 c3');
  const entry = ir.blocks.find((block) => block.id === ir.entry)!;
  assert.ok(entry.instructions.some((instruction) => instruction.kind === 'unknown_effect'));
  assert.equal(entry.terminator.kind, 'branch');
  assert.equal(ir.blocks.filter((block) => block.terminator.kind === 'return').length, 2);
});

test('an unsupported instruction with a non-sequential flow still ends the block', () => {
  // Invalid encoding (0x06 is not a long-mode opcode): no modeled successor.
  const { ir, graph } = liftBytes('90 06 b8 07 00 00 00 c3');
  const entry = ir.blocks.find((block) => block.id === ir.entry)!;
  assert.equal(entry.terminator.kind, 'unknown');
  assert.ok(entry.instructions.some((instruction) => instruction.kind === 'unknown_effect'));
  assert.ok(
    !entry.instructions.some(
      (instruction) =>
        instruction.kind === 'write_register' && instruction.register.root === 'x86_64:rax',
    ),
  );
  assert.ok(graph.instructions.length >= 2);
});

const mask = (width: number): bigint => (1n << BigInt(width)) - 1n;
const flagAt = (result: ReturnType<typeof run>, offset: number): bigint =>
  register(result, 'rflags', 1, offset);

test('BTS register forms: CF takes the old bit, the bit is set, offsets wrap at the operand width', () => {
  // modrm c8 = bts eax/ax/rax, ecx/cx/rcx.
  for (const [prefix, width] of [
    ['66 ', 16],
    ['', 32],
    ['48 ', 64],
  ] as const) {
    const { ir, coverage } = liftBytes(`${prefix}0f ab c8 c3`);
    assert.ok(!coverage.reasons.some((reason) => reason.includes('Instruction family')));
    const initial = 0x8123456789abcdefn,
      old = initial & mask(width);
    for (const offset of [
      0n,
      1n,
      5n,
      BigInt(width - 1),
      BigInt(width),
      BigInt(width + 3),
      0x1234567n,
      -1n,
    ]) {
      const raw = BigInt.asUintN(width, offset),
        bit = raw & BigInt(width - 1);
      const result = run(ir, {
        rax: initial,
        rcx: (0xaaaaaaaaaaaaaaaan & ~mask(width)) | raw,
        rflags: 0n,
      });
      const low = old | (1n << bit);
      // 32-bit writes zero the upper half and 16-bit writes preserve it.
      const expected = width === 16 ? (initial & ~mask(16)) | low : low;
      assert.equal(register(result, 'rax'), expected, `${width}-bit offset ${offset}`);
      assert.equal(cfBit(result), (old >> bit) & 1n, `${width}-bit offset ${offset} CF`);
    }
  }
});

function cfBit(result: ReturnType<typeof run>): bigint {
  return flagAt(result, 0);
}

test('BTS immediate register forms use the offset modulo the operand width', () => {
  for (const [prefix, width] of [
    ['66 ', 16],
    ['', 32],
    ['48 ', 64],
  ] as const) {
    const initial = 0x0123456789abcdefn,
      old = initial & mask(width);
    for (const immediate of [0, 3, 15, 16, 31, 32, 63, 64, 200, 255]) {
      const hex = immediate.toString(16).padStart(2, '0');
      const { ir } = liftBytes(`${prefix}0f ba e8 ${hex} c3`); // bts eax/ax/rax, imm8
      const result = run(ir, { rax: initial, rflags: 0n });
      const bit = BigInt(immediate % width),
        low = old | (1n << bit);
      assert.equal(
        register(result, 'rax'),
        width === 16 ? (initial & ~mask(16)) | low : low,
        `${width}-bit #${immediate}`,
      );
      assert.equal(cfBit(result), (old >> bit) & 1n);
    }
  }
});

test('BTS leaves ZF unchanged and makes OF/SF/AF/PF undefined', () => {
  const { ir } = liftBytes('0f ab c8 c3');
  for (const rflags of [0n, 1n << 6n]) {
    const result = run(ir, { rax: 0n, rcx: 1n, rflags });
    assert.equal(flagAt(result, 6), (rflags >> 6n) & 1n);
    const state = result.registers.get('x86_64:rflags')!;
    for (const offset of [2n, 4n, 7n, 11n]) assert.equal((state.undefined >> offset) & 1n, 1n);
    for (const offset of [0n, 6n]) assert.equal((state.undefined >> offset) & 1n, 0n);
  }
});

test('BTS on memory: an immediate offset stays inside the operand; a register offset addresses the signed bit string', () => {
  const pattern = Uint8Array.from({ length: 0x200 }, (_, index) => (index * 37 + 11) & 255);
  const region = (): { base: bigint; bytes: Uint8Array; writable: boolean } => ({
    base: 0x2000n,
    bytes: Uint8Array.from(pattern),
    writable: true,
  });
  const middle = 0x2100n;
  for (const [prefix, width] of [
    ['66 ', 16],
    ['', 32],
    ['48 ', 64],
  ] as const) {
    // bts [rdx], rcx
    const register_form = liftBytes(`${prefix}0f ab 0a c3`).ir;
    for (const offset of [
      0n,
      1n,
      7n,
      8n,
      BigInt(width - 1),
      BigInt(width),
      BigInt(width + 3),
      2n * BigInt(width) + 5n,
      -1n,
      -8n,
      -BigInt(width),
      -BigInt(width) - 1n,
      -BigInt(width) - 9n,
      0x7ffn,
      -0x800n,
    ]) {
      const result = run(
        register_form,
        {
          rdx: middle,
          rcx: (0x5555555555555555n & ~mask(width)) | BigInt.asUintN(width, offset),
          rflags: 0n,
        },
        { memory: [region()] },
      );
      // Independent bit-string reference: byte floor(offset / 8), bit offset mod 8.
      const expected = Uint8Array.from(pattern);
      const index = Number(0x100n + (offset >> 3n)),
        bit = Number(offset & 7n);
      const old = (expected[index]! >> bit) & 1;
      expected[index]! |= 1 << bit;
      const output = result.memory.find((item) => item.base === 0x2000n)!;
      assert.deepEqual(output.bytes, expected, `${width}-bit offset ${offset}`);
      assert.equal(cfBit(result), BigInt(old), `${width}-bit offset ${offset} CF`);
    }
    // bts dword/word/qword [rdx], imm8: the offset wraps within the addressed operand.
    for (const immediate of [0, 5, width - 1, width, width + 9, 255]) {
      const hex = immediate.toString(16).padStart(2, '0');
      const result = run(
        liftBytes(`${prefix}0f ba 2a ${hex} c3`).ir,
        { rdx: middle, rflags: 0n },
        { memory: [region()] },
      );
      const expected = Uint8Array.from(pattern);
      const bit = immediate % width,
        index = 0x100 + (bit >> 3);
      const old = (expected[index]! >> (bit & 7)) & 1;
      expected[index]! |= 1 << (bit & 7);
      assert.deepEqual(result.memory.find((item) => item.base === 0x2000n)!.bytes, expected);
      assert.equal(cfBit(result), BigInt(old));
    }
  }
});

test('BTS sub-forms with unmodeled semantics remain explicit unknown effects', () => {
  for (const code of [
    'f0 0f ab 0a', // LOCK
    '67 0f ab 0a', // register bit offset beyond a 32-bit-address operand
  ]) {
    const lifted = liftBytes(`${code} c3`);
    assert.equal(lifted.coverage.state, 'partial');
    assert.ok(
      lifted.ir.blocks.some((block) =>
        block.instructions.some((instruction) => instruction.kind === 'unknown_effect'),
      ),
      code,
    );
    assert.equal(run(lifted.ir, { rdx: 0x2100n, rcx: 1n }).status, 'unknown');
  }
  // The immediate form with a 32-bit address size is exact.
  const exact = liftBytes('67 0f ba 2a 03 c3');
  assert.ok(
    !exact.ir.blocks.some((block) =>
      block.instructions.some((instruction) => instruction.kind === 'unknown_effect'),
    ),
  );
});

test('PUNPCKLBW interleaves the low bytes of destination and source and preserves upper vector bits', () => {
  const left = 0x0f0e0d0c0b0a0908_0706050403020100n,
    right = 0x1f1e1d1c1b1a1918_1716151413121110n;
  const high = 0xabcdn << 256n;
  const interleave = (a: bigint, b: bigint): bigint => {
    let result = 0n;
    for (let index = 0n; index < 8n; index++) {
      result |= ((a >> (8n * index)) & 255n) << (16n * index);
      result |= ((b >> (8n * index)) & 255n) << (16n * index + 8n);
    }
    return result;
  };
  const registerForm = liftBytes('66 0f 60 c1 c3').ir; // punpcklbw xmm0, xmm1
  let result = run(registerForm, { zmm0: high | left, zmm1: right });
  assert.equal(register(result, 'zmm0', 128), interleave(left, right));
  assert.equal(register(result, 'zmm0', 384, 128), high >> 128n);
  assert.equal(register(result, 'zmm1', 128), right);
  // Same register on both sides.
  result = run(liftBytes('66 0f 60 c0 c3').ir, { zmm0: left });
  assert.equal(register(result, 'zmm0', 128), interleave(left, left));
  // Memory source: the full 128 bits are read and must be 16-byte aligned.
  const bytes = Buffer.alloc(32);
  bytes.writeBigUInt64LE(right & mask(64), 0);
  bytes.writeBigUInt64LE(right >> 64n, 8);
  const memoryForm = liftBytes('66 0f 60 01 c3').ir; // punpcklbw xmm0, [rcx]
  result = run(
    memoryForm,
    { zmm0: high | left, rcx: 0x2000n },
    { memory: [{ base: 0x2000n, bytes, writable: false }] },
  );
  assert.equal(register(result, 'zmm0', 128), interleave(left, right));
  assert.equal(register(result, 'zmm0', 384, 128), high >> 128n);
  assert.equal(
    run(
      memoryForm,
      { zmm0: left, rcx: 0x2008n },
      { memory: [{ base: 0x2000n, bytes, writable: false }] },
    ).status,
    'memory_fault',
  );
});

test('only the legacy SSE PUNPCKLBW form is modeled', () => {
  for (const code of ['0f 60 c1', 'c5 f9 60 c1']) {
    const lifted = liftBytes(`${code} c3`);
    assert.ok(
      lifted.ir.blocks.some((block) =>
        block.instructions.some((instruction) => instruction.kind === 'unknown_effect'),
      ),
      code,
    );
  }
});
