import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOperationContext, type AbiSignature } from '../../../src/core/index.js';
import { cScalarSupport } from '../../../src/emitters/source-c-support.js';
import { SourcePrinter } from '../../../src/emitters/expressions.js';
import { Writer } from '../../../src/emitters/writer.js';
import { integer, type IntegerOp } from '../../../src/ir/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { windowsX64Abi } from '../../../src/abi/windows-x64/index.js';
import { recoverTypes } from '../../../src/analysis/types/index.js';
import { recoverDataAddress } from '../../../src/analysis/strings/source-data.js';
import { recoverLibraryContracts } from '../../../src/metadata/library-contracts/index.js';
import { navigationBytes } from '../../analysis/navigation-fixture.js';
import type { SSAForm } from '../../../src/ir/index.js';
import { builder, image, register } from '../../ir/support.js';
import { emit, emittedFormals, execute } from './support.js';

test('exact emitted C scalar helpers preserve widths, signed division and full shift counts', () => {
  const operations: IntegerOp[] = [
    'udiv',
    'urem',
    'sdiv',
    'srem',
    'rol',
    'ror',
    'shl',
    'lshr',
    'ashr',
  ];
  const checks: string[] = [];
  const literal = (n: bigint) =>
    `(((uint128_t)0x${(n >> 64n).toString(16)}ULL << 64) | 0x${(n & ((1n << 64n) - 1n)).toString(16)}ULL)`;
  for (const width of [8, 16, 32, 64, 128]) {
    const bits = BigInt(width),
      mask = (1n << bits) - 1n;
    for (const a of [0n, 1n, mask, 1n << (bits - 1n), (1n << (bits - 1n)) + 1n]) {
      for (const b of [1n, 3n, bits - 1n, bits, bits + 1n, mask]) {
        for (const op of operations) {
          const x = BigInt.asIntN(width, a),
            y = BigInt.asIntN(width, b),
            n = b % bits;
          if ((op === 'sdiv' || op === 'srem') && x === -(1n << (bits - 1n)) && y === -1n) continue;
          const expected = BigInt.asUintN(
            width,
            op === 'udiv'
              ? a / b
              : op === 'urem'
                ? a % b
                : op === 'sdiv'
                  ? x / y
                  : op === 'srem'
                    ? x % y
                    : op === 'rol'
                      ? (a << n) | (a >> ((bits - n) % bits))
                      : op === 'ror'
                        ? (a >> n) | (a << ((bits - n) % bits))
                        : op === 'shl'
                          ? b >= bits
                            ? 0n
                            : a << b
                          : op === 'lshr'
                            ? b >= bits
                              ? 0n
                              : a >> b
                            : b >= bits
                              ? x < 0n
                                ? mask
                                : 0n
                              : x >> b,
          );
          checks.push(
            `if ((uint128_t)bv_${op}(${width}, ${literal(a)}, ${literal(b)}) != ${literal(expected)}) return ${(checks.length % 250) + 1};`,
          );
        }
      }
    }
  }
  for (const width of [64, 128]) {
    const base = BigInt.asUintN(width, 0x123456789abcdef0fedcba9876543210n);
    for (const partWidth of [1, 8, 32, width]) {
      for (const offset of [0, width - partWidth]) {
        const mask = (1n << BigInt(partWidth)) - 1n,
          value = 0xfedcba9876543210n & mask;
        const expected = (base & ~(mask << BigInt(offset))) | (value << BigInt(offset));
        checks.push(
          `if ((uint128_t)insert_bits(${width}, ${literal(base)}, ${partWidth}, ${literal(value)}, ${offset}) != ${literal(expected)}) return 251;`,
        );
      }
    }
  }
  for (const width of [8, 64, 128]) {
    const minimum = -(1n << BigInt(width - 1)),
      maximum = -minimum - 1n;
    for (const a of [minimum, -1n, 0n, maximum])
      for (const b of [minimum, -1n, 0n, maximum])
        for (const borrow of [0n, 1n]) {
          const result = a - b - borrow,
            expected = Number(result < minimum || result > maximum);
          checks.push(
            `if (flag_sub_overflow(${width}, ${literal(BigInt.asUintN(width, a))}, ${literal(BigInt.asUintN(width, b))}, ${borrow}) != ${expected}) return 252;`,
          );
        }
  }
  for (const width of [8, 64, 128]) {
    const maximum = (1n << BigInt(width)) - 1n;
    for (const a of [0n, 1n, maximum - 1n, maximum])
      for (const b of [0n, 1n, maximum - 1n, maximum])
        for (const carry of [0n, 1n])
          checks.push(
            `if (flag_add_carry(${width}, ${literal(a)}, ${literal(b)}, ${carry}) != ${Number(a + b + carry > maximum)}) return 253;`,
          );
  }
  const body = checks.join('\n'),
    prelude = cScalarSupport(body);
  const directory = mkdtempSync(join(tmpdir(), 'open-decomp-c-support-'));
  try {
    const path = join(directory, 'support.c'),
      binary = join(directory, 'support');
    writeFileSync(
      path,
      `#include <stdint.h>\n${prelude.join('\n')}\nint main(void) {\n${body}\nreturn 0;\n}\n`,
    );
    execFileSync('clang', ['-std=c11', '-Wall', '-Werror', path, '-o', binary]);
    execFileSync(binary);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(checks.length, 1548);
});

test('C scalar support emits only helpers the text references, with their dependencies', () => {
  assert.deepEqual(cScalarSupport('uint64_t f(uint64_t a) { return a + 1; }'), []);
  assert.deepEqual(
    cScalarSupport(
      '/* flag_sub_overflow(8, a, b) bool */ puts("bv_shl(8, a, b) __od_bitcast_f32_u32");',
    ),
    [],
  );
  assert.deepEqual(cScalarSupport('while (true) { }'), ['#include <stdbool.h>']);
  const shifts = cScalarSupport('x = bv_shl(32, a, b); y = vector_bv_shl("x", a, b);');
  assert.deepEqual(
    shifts.map((line) => line.replace(/\{.*$/, '').trim()),
    [
      '#define uint128_t __uint128_t',
      '#define __od_uint_32_t uint32_t',
      'static inline uint128_t __od_bv_shl(unsigned width, uint128_t a, uint128_t b)',
      '#define bv_shl(width, a, b) ((__od_uint_##width##_t)__od_bv_shl(width, a, b))',
    ],
  );
  const division = cScalarSupport('x = bv_sdiv(16, a, b); y = flag_add_carry(8, a, b, 0);');
  assert.ok(division.includes('#define int128_t __int128_t'));
  assert.ok(division.some((line) => line.startsWith('static inline uint8_t flag_add_carry')));
  assert.ok(!division.some((line) => line.includes('flag_sub_overflow')));
  const cast = cScalarSupport('x = __od_bitcast_u64_f64(y);');
  assert.deepEqual(
    cast.map((line) => line.replace(/\{.*$/, '').trim()),
    ['#include <string.h>', 'static inline uint64_t __od_bitcast_u64_f64(double value)'],
  );
});

test('C bitcasts preserve IEEE payloads and odd-width conversions preserve exact signed bits', () => {
  const writer = new Writer(createOperationContext(), 2, false);
  const printer = new SourcePrinter(writer, true);
  const checks: string[] = [];
  const literal = (n: bigint) =>
    `(((uint128_t)0x${(n >> 64n).toString(16)}ULL << 64) | 0x${(n & ((1n << 64n) - 1n)).toString(16)}ULL)`;
  for (const bits of [5, 24, 40, 63, 65, 127]) {
    for (const value of [
      0n,
      1n,
      (1n << BigInt(bits - 1)) - 1n,
      1n << BigInt(bits - 1),
      (1n << BigInt(bits)) - 1n,
      (1n << 128n) - 1n,
    ]) {
      for (const signed of [false, true]) {
        const expression = printer.cast(
          bits,
          signed,
          printer.primary('input', { bits: 128, signed: false }),
        );
        const expected = signed
          ? BigInt.asUintN(128, BigInt.asIntN(bits, value))
          : BigInt.asUintN(bits, value);
        checks.push(
          `input = ${literal(value)}; if ((uint128_t)(${expression.text}) != ${literal(expected)}) return 1;`,
        );
      }
    }
  }
  for (const [bits, payloads] of [
    [32, [0n, 0x80000000n, 0x7fa12345n, 0xffc01234n, 0x00000001n]],
    [64, [0n, 0x8000000000000000n, 0x7ff0123456789abcn, 0xfff8123456789abcn, 1n]],
  ] as const) {
    for (const payload of payloads)
      checks.push(
        `if (__od_bitcast_u${bits}_f${bits}(__od_bitcast_f${bits}_u${bits}((uint${bits}_t)${literal(payload)})) != (uint${bits}_t)${literal(payload)}) return 2;`,
      );
  }
  const body = checks.join('\n');
  const directory = mkdtempSync(join(tmpdir(), 'open-decomp-c-bits-'));
  try {
    const path = join(directory, 'bits.c'),
      binary = join(directory, 'bits');
    writeFileSync(
      path,
      `#include <stdint.h>\n${cScalarSupport(body).join('\n')}\nint main(void) { uint128_t input;\n${body}\nreturn 0;\n}\n`,
    );
    execFileSync('clang', ['-std=c11', '-Wall', '-Werror', path, '-o', binary]);
    execFileSync(binary);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(checks.length, 82);
});

test('odd-width emitted source uses real C storage without losing wraparound', () => {
  const b = builder('c-odd-width-storage'),
    block = b.block('entry');
  const input = block.readRegister(register('rdi', 64, 0, 'replace_root', 'x86_64:rdi'));
  const narrow = block.cast('truncate', integer(24), input);
  const result = block.int('add', narrow, block.constant(integer(24), 0xfffffen));
  block.return([block.cast('zero_extend', integer(64), result)]);
  const ir = constructSSA(b.finish(block, [integer(64)])).value as SSAForm;
  const source = { abi: sysvAMD64Abi, callees: [], addresses: [] };
  const directory = mkdtempSync(join(tmpdir(), 'open-decomp-odd-source-'));
  try {
    for (const language of ['c-like', 'python-like'] as const) {
      const { emission } = emit(ir, { source }, language);
      if (language === 'c-like') {
        assert.ok(emission.local_validation?.some((record) => record.rule === 'c_integer_storage'));
        assert.doesNotMatch(emission.text, /\buint24_t\b/);
      }
      const formal = emittedFormals(emission)[0]!;
      for (const value of [0n, 1n, 0xffffffn, 0xffffffffn, 0xffffffffffffffffn])
        assert.deepEqual(execute(emission, new Map([[formal.statement_id, value]])).values, [
          BigInt.asUintN(24, value + 0xfffffen),
        ]);
      const path = join(directory, language === 'c-like' ? 'source.c' : 'source.py');
      writeFileSync(path, emission.text);
      if (language === 'c-like')
        execFileSync('clang', [
          '-fsyntax-only',
          '-std=c11',
          '-include',
          'stdint.h',
          '-include',
          'stddef.h',
          path,
        ]);
      else execFileSync('python3', ['-m', 'py_compile', path]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('nonstandard-width memory accesses never acquire larger C storage', () => {
  const b = builder('c-odd-memory-fallback'),
    block = b.block('entry');
  const value = block.load(integer(24), block.constant(integer(64), 0x1000n));
  block.return([block.cast('zero_extend', integer(64), value)]);
  const ir = constructSSA(b.finish(block, [integer(64)])).value as SSAForm;
  const source = { abi: sysvAMD64Abi, callees: [], addresses: [] };
  const { emission } = emit(ir, { source }, 'c-like');
  assert.equal(
    emission.local_validation?.some((record) => record.rule === 'c_integer_storage'),
    false,
  );
  assert.match(emission.text, /uint24_t/);
  assert.deepEqual(
    execute(
      emission,
      new Map(),
      new Map([
        [0x1000n, 1],
        [0x1001n, 2],
        [0x1002n, 3],
      ]),
    ).values,
    [0x030201n],
  );
});

test('untyped named image addresses compile without inventing an extern object type', () => {
  const b = builder('c-untyped-image-address'),
    block = b.block('entry');
  const address = { image_id: image, space: 'va' as const, value: 0x1234n };
  block.return([block.address(address)]);
  const ir = constructSSA(b.finish(block, [integer(64)])).value as SSAForm;
  const source = {
    abi: sysvAMD64Abi,
    callees: [],
    addresses: [{ address, name: 'case */ global' }],
  };
  const { emission } = emit(ir, { source }, 'c-like');
  assert.ok(emission.local_validation?.some((record) => record.rule === 'symbolic_address'));
  assert.doesNotMatch(emission.text, /extern/);
  assert.deepEqual(execute(emission, new Map()).values, [0x1234n]);
  const directory = mkdtempSync(join(tmpdir(), 'open-decomp-symbol-address-'));
  try {
    const path = join(directory, 'source.c');
    writeFileSync(path, emission.text);
    execFileSync('clang', [
      '-fsyntax-only',
      '-std=c11',
      '-include',
      'stdint.h',
      '-include',
      'stddef.h',
      path,
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const conflict of [false, true])
  test(`call interfaces observed only at call sites (${conflict ? 'conflicting' : 'consistent'}) are not declared; their open arity is named once, effects unchanged`, () => {
    const b = builder(`c-prototype-${conflict}`),
      block = b.block('entry');
    const target = {
      kind: 'direct' as const,
      address: { image_id: image, space: 'va' as const, value: 0x4000n },
    };
    const clobbers = { registers: [], flags: [], memory: 'unknown_read_write' as const };
    const first = block.call(
      target,
      [block.constant(integer(64), 7n)],
      [integer(64)],
      clobbers,
    )[0]!;
    const second = block.call(
      target,
      [block.constant(integer(conflict ? 32 : 64), 9n)],
      [integer(64)],
      clobbers,
    )[0]!;
    block.return([block.int('add', first, second)]);
    const ir = constructSSA(b.finish(block, [integer(64)])).value as SSAForm;
    const source = { abi: sysvAMD64Abi, callees: [], addresses: [] };
    const { emission } = emit(ir, { source }, 'c-like');
    // No prototype is established: the call prints the interface, and the open arity
    // is stated on one comment line, not by a declaration or a marker at each call.
    assert.doesNotMatch(emission.text, /^extern /m);
    assert.ok(!emission.local_validation?.some((record) => record.rule === 'call_declaration'));
    assert.match(emission.text, /^\/\* open arity \([^)]*\): sub_4000 \*\/$/m);
    assert.match(emission.text, /sub_4000\(7\)/);
    assert.doesNotMatch(emission.text, /, \.\.\.\)/);
    assert.ok(emission.helpers.some((helper) => helper.name === 'unknown_argument_remainder'));
    const observed = execute(
      emission,
      new Map(),
      new Map(),
      0n,
      new Map(),
      new Map(),
      new Map([['sub_4000', (args: readonly bigint[]) => args[0]! * 2n]]),
    );
    assert.deepEqual(observed.values, [32n]);
    assert.deepEqual(observed.events, ['call', 'call']);
    const checked = emit(ir, { source }, 'c-like', 'checked').emission.text;
    assert.doesNotMatch(checked, /^extern |__od_bv_/m);
    // The checked view keeps the named remainder helper at every open call.
    assert.match(checked, /sub_4000\(7, unknown_argument_remainder\(\)\)/);
    // Python-like states the open arity the same way.
    const python = emit(ir, { source }, 'python-like').emission.text;
    assert.match(python, /^# open arity \([^)]*\): sub_4000$/m);
    assert.match(python, /sub_4000\(7\)/);
    assert.doesNotMatch(python, /\.\.\./);
  });

for (const language of ['c-like', 'python-like'] as const)
  test(`${language}: an open call that proves no argument keeps its marker and is not named as open`, () => {
    const b = builder(`open-no-arguments-${language}`),
      block = b.block('entry');
    const target = {
      kind: 'direct' as const,
      address: { image_id: image, space: 'va' as const, value: 0x4000n },
    };
    const clobbers = { registers: [], flags: [], memory: 'unknown_read_write' as const };
    const result = block.call(target, [], [integer(64)], clobbers)[0]!;
    block.return([result]);
    const ir = constructSSA(b.finish(block, [integer(64)])).value as SSAForm;
    const source = { abi: sysvAMD64Abi, callees: [], addresses: [] };
    const { text } = emit(ir, { source }, language).emission;
    assert.match(text, /sub_4000\(\.\.\.\)/);
    assert.match(text, /\.\.\.: more args possible/);
    assert.doesNotMatch(text, /open arity/);
  });

test('library C strings retain const char prototypes and bare proven literals', () => {
  const base = navigationBytes(Uint8Array.of(0xc3), Buffer.from('value=%d\n\0'));
  const target = { image_id: base.id, space: 'va' as const, value: 0x1000n };
  const address = { ...target, value: 0x2000n };
  const loaded = {
    ...base,
    mappings: base.mappings.map((mapping) => ({ ...mapping, permissions: ['read'] as const })),
    sections: base.sections.map((section) => ({ ...section, permissions: ['read'] as const })),
    imports: [
      {
        id: 'printf-import',
        original_name: 'printf',
        display_name: null,
        library: 'ucrtbase.dll',
        ordinal: null,
        slot: null,
        callable_entry: target,
        delayed: false,
        weak: false,
        evidence_ids: ['printf-binding'],
      },
    ],
  };
  const library = recoverLibraryContracts(
    { image: loaded, abi: windowsX64Abi, revision: 0 },
    createOperationContext(),
  );
  assert.equal(library.contracts.length, 1);
  const string = recoverDataAddress(loaded, address, createOperationContext())!;
  assert.equal(string.object?.mutable, false);
  const b = builder('c-library-string'),
    block = b.block('entry');
  block.writeRegister(register('rcx', 64, 0, 'replace_root', 'x86_64:rcx'), block.address(address));
  block.writeRegister(
    register('rdx', 64, 0, 'replace_root', 'x86_64:rdx'),
    block.constant(integer(64), 37n),
  );
  block.call({ kind: 'direct', address: target }, [], [], windowsX64Abi.unknown_call_clobbers);
  block.return([block.constant(integer(32), 99n)]);
  const ir = constructSSA(b.finish(block, [integer(32)])).value as SSAForm;
  const call = ir.blocks[0]!.instructions.find((node) => node.kind === 'call')!;
  const types = recoverTypes(ir, windowsX64Abi, createOperationContext(), {
    image_id: base.id,
    slice_id: base.selected_slice_id,
    revision: 0,
    library,
  });
  const actuals: AbiSignature = {
    returns: { kind: 'integer', bits: 32, signed: true },
    parameters: [{ kind: 'pointer' }, { kind: 'integer', bits: 32, signed: true }],
    variadic: true,
    fixed_parameter_count: 1,
    argument_list_complete: true,
  };
  const source = {
    abi: windowsX64Abi,
    callees: [],
    addresses: [string],
    call_argument_signatures: new Map([[call.id, actuals]]),
  };
  const { emission } = emit(
    ir,
    { types, source, names: [{ entity_id: call.id, name: 'printf' }] },
    'c-like',
  );
  assert.match(emission.text, /extern int32_t printf\(const char\*, \.\.\.\);/);
  assert.match(emission.text, /printf\("value=%d\\n",/);
  assert.doesNotMatch(emission.text, /uintptr_t\)\("value=/);
  assert.ok(
    emission.local_validation?.some((record) => record.rule === 'library_string_parameter'),
  );
  const directory = mkdtempSync(join(tmpdir(), 'open-decomp-c-string-'));
  try {
    const path = join(directory, 'source.c');
    writeFileSync(path, emission.text);
    execFileSync('clang', [
      '-fsyntax-only',
      '-std=c11',
      '-include',
      'stdint.h',
      '-include',
      'stddef.h',
      path,
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
