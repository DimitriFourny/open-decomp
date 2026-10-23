import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import type { AbiProfile } from '../../../src/core/index.js';
import { integer, type DataType, type SSAForm, type Value } from '../../../src/ir/index.js';
import type { BlockBuilder } from '../../../src/ir/builder.js';
import { builder, image } from '../../ir/support.js';
import { emit, emittedFormals, execute } from './support.js';

type Language = 'c-like' | 'python-like';
const LANGUAGES: readonly Language[] = ['c-like', 'python-like'];

interface Fixture {
  readonly ir: SSAForm;
  readonly source: { readonly abi: AbiProfile; readonly callees: []; readonly addresses: [] };
}

/** One FP argument in its ABI register, returned (or stored) through `make`. */
function build(
  bits: 32 | 64,
  name: string,
  make: (block: BlockBuilder, input: Value, fp: DataType) => Value,
  escape = false,
): Fixture {
  const abi = sysvAMD64Abi,
    fp: DataType = { kind: 'float', bits };
  const location = abi.classifyCall({
    returns: fp,
    parameters: [fp],
    variadic: false,
    fixed_parameter_count: 1,
  }).parameters[0]!.locations[0]!;
  assert.equal(location.kind, 'register');
  if (location.kind !== 'register') throw new Error('FP argument register required');
  const b = builder(`native-${name}-${bits}-${escape}`),
    entry = b.block('entry');
  const input = entry.cast(
    'bitcast',
    fp,
    entry.readRegister({ ...location.register, width_bits: bits }),
  );
  const result = make(entry, input, fp);
  if (escape)
    entry.store(
      entry.constant(integer(64), 0x2000n),
      result.type.kind === 'float'
        ? entry.cast('bitcast', integer(result.type.bits), result)
        : result,
    );
  entry.return([result]);
  const ir = constructSSA(b.finish(entry, [result.type])).value as SSAForm;
  return { ir, source: { abi, callees: [], addresses: [] } };
}

const unary =
  (op: 'neg' | 'abs' | 'sqrt') =>
  (block: BlockBuilder, input: Value, fp: DataType): Value =>
    block.assign(fp, { kind: 'float_unary', op, value: input });
const convert =
  (op: 'float_to_signed' | 'float_to_unsigned') =>
  (block: BlockBuilder, input: Value): Value =>
    block.cast(op, integer(32), input);

const FP_CASES: Record<32 | 64, readonly bigint[]> = {
  32: [0n, 0x80000000n, 1n, 0x40400000n, 0xc0200000n, 0x7f7fffffn, 0x7f800000n, 0x7fc12345n],
  64: [
    0n,
    0x8000000000000000n,
    1n,
    0x4008000000000000n,
    0xc004000000000000n,
    0x7fefffffffffffffn,
    0x7ff0000000000000n,
    0x7ff8123456789abcn,
  ],
};

/** IEEE bits of the given width are a NaN. */
const isNaNBits = (value: bigint, bits: 32 | 64): boolean =>
  bits === 32
    ? (value & 0x7fffffffn) > 0x7f800000n
    : (value & 0x7fffffffffffffffn) > 0x7ff0000000000000n;
/** NaN payloads are unobserved: two NaNs agree, every other result is bit-exact. */
const sameModuloPayload = (a: bigint, b: bigint, bits: 32 | 64): boolean =>
  a === b || (isNaNBits(a, bits) && isNaNBits(b, bits));

function agree(f: Fixture, language: Language, bits: 32 | 64): void {
  const source = emit(f.ir, { source: f.source }, language).emission;
  const checked = emit(f.ir, { source: f.source }, language, 'checked').emission;
  for (const input of FP_CASES[bits]) {
    const [actual, expected] = [source, checked].map((emission) =>
      execute(
        emission,
        new Map(
          emittedFormals(emission).flatMap((formal) =>
            formal.semantic_ids.map((id) => [id, input] as const),
          ),
        ),
      ),
    );
    assert.equal(actual!.exit, expected!.exit, `${language} ${bits} 0x${input.toString(16)}`);
    assert.equal(actual!.values.length, expected!.values.length);
    actual!.values.forEach((value, index) =>
      assert.ok(
        sameModuloPayload(value, expected!.values[index]!, bits),
        `${language} ${bits} 0x${input.toString(16)}: 0x${value.toString(16)} vs 0x${expected!.values[index]!.toString(16)}`,
      ),
    );
  }
}

for (const bits of [32, 64] as const)
  for (const language of LANGUAGES)
    test(`${language}: native FP${bits} negation, absolute value and square root`, () => {
      const suffix = bits === 32 ? 'f' : '';
      for (const op of ['neg', 'abs', 'sqrt'] as const) {
        const f = build(bits, op, unary(op));
        const text = emit(f.ir, { source: f.source }, language).emission.text;
        const native = language === 'c-like' ? true : bits === 64 && op !== 'sqrt';
        assert.equal(text.includes(`fp_${op}(`), !native, text);
        if (native)
          assert.match(
            text,
            language === 'python-like'
              ? op === 'neg'
                ? /return -\w+/
                : /return abs\(\w+\)/
              : op === 'neg'
                ? /return -\w+;/
                : new RegExp(
                    `return __builtin_${op === 'abs' ? 'fabs' : 'sqrt'}${suffix}\\(\\w+\\);`,
                  ),
          );
        agree(f, language, bits);
      }
    });

for (const bits of [32, 64] as const)
  for (const language of LANGUAGES)
    test(`${language}: native FP${bits} operations stored to memory keep no helper (NaN payloads are unobserved)`, () => {
      for (const op of ['neg', 'abs', 'sqrt'] as const) {
        const f = build(bits, op, unary(op), true);
        const text = emit(f.ir, { source: f.source }, language).emission.text;
        const native = language === 'c-like' || (bits === 64 && op !== 'sqrt');
        assert.equal(text.includes(`fp_${op}(`), !native, text);
        // The result escapes through memory; negation and absolute value stay
        // bit-exact, a square root of a NaN agrees modulo payload.
        agree(f, language, bits);
      }
    });

for (const bits of [32, 64] as const)
  test(`c-like: native FP${bits} float-to-integer conversion truncates and is undefined out of range`, () => {
    for (const op of ['float_to_signed', 'float_to_unsigned'] as const) {
      const f = build(bits, op, convert(op));
      const text = emit(f.ir, { source: f.source }).emission.text;
      assert.match(text, op === 'float_to_signed' ? /\(int32_t\)/ : /\(uint32_t\)/);
      assert.doesNotMatch(text, /cast_float_to_/);
      const python = emit(f.ir, { source: f.source }, 'python-like').emission.text;
      assert.match(python, /cast_float_to_/);
      const checked = emit(f.ir, { source: f.source }, 'c-like', 'checked').emission.text;
      assert.match(checked, /cast_float_to_/);
    }
  });

test('native FP float-to-integer conversion hides no arithmetic payload from its operand', () => {
  for (const bits of [32, 64] as const) {
    // The converted sum is an integer: the NaN payload of the sum is unobservable.
    const f = build(
      bits,
      'sum-convert',
      (block, input, fp) =>
        block.cast(
          'float_to_signed',
          integer(32),
          block.assign(fp, { kind: 'float', op: 'add', left: input, right: input }),
        ),
      true,
    );
    for (const language of LANGUAGES) {
      const text = emit(f.ir, { source: f.source }, language).emission.text;
      // Python binary32 arithmetic always keeps its helper.
      assert.equal(/fp_add\(/.test(text), language === 'python-like' && bits === 32, text);
      assert.equal(/cast_float_to_signed\(/.test(text), language === 'python-like', text);
    }
    // A stored sum is consumed as a value: native. An integer consumer of its
    // bits observes the payload, so the helper stays.
    const stored = build(
      bits,
      'sum-stored',
      (block, input, fp) =>
        block.assign(fp, { kind: 'float', op: 'add', left: input, right: input }),
      true,
    );
    const observed = build(bits, 'sum-observed', (block, input, fp) => {
      const sum = block.assign(fp, { kind: 'float', op: 'add', left: input, right: input });
      block.store(
        block.constant(integer(64), 0x2000n),
        block.int(
          'add',
          block.cast('bitcast', integer(bits), sum),
          block.constant(integer(bits), 1n),
        ),
      );
      return sum;
    });
    for (const language of LANGUAGES) {
      assert.equal(
        /fp_add\(/.test(emit(stored.ir, { source: stored.source }, language).emission.text),
        language === 'python-like' && bits === 32,
      );
      assert.match(
        emit(observed.ir, { source: observed.source }, language).emission.text,
        /fp_add\(/,
      );
    }
  }
});

test('exact emitted native FP unary and conversion C executes under clang', () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-decomp-native-fp-unary-'));
  try {
    for (const bits of [32, 64] as const)
      for (const op of ['neg', 'abs', 'sqrt', 'float_to_signed', 'float_to_unsigned'] as const) {
        const f =
          op === 'float_to_signed' || op === 'float_to_unsigned'
            ? build(bits, op, convert(op))
            : build(bits, op, unary(op));
        const output = emit(f.ir, { source: f.source });
        const checked = emit(f.ir, { source: f.source }, 'c-like', 'checked').emission;
        const name = output.identifiers.find((item) => item.entity_id === f.ir.id)!.identifier;
        const converting = op === 'float_to_signed' || op === 'float_to_unsigned';
        // In-range, finite inputs only: out-of-range conversion is undefined.
        const inputs = FP_CASES[bits].filter((input, index) =>
          converting
            ? [0n, 0x80000000n, 1n, 0x40400000n, 0x4008000000000000n].includes(input) && index !== 2
            : true,
        );
        const checks = inputs.map((input) => {
          const expected = execute(
            checked,
            new Map(
              emittedFormals(checked).flatMap((formal) =>
                formal.semantic_ids.map((id) => [id, input] as const),
              ),
            ),
          ).values[0]!;
          if (converting)
            return `{ uint${bits}_t bits = 0x${input.toString(16)}ULL; ${bits === 32 ? 'float' : 'double'} input; memcpy(&input, &bits, sizeof(input)); if (${name}(input) != 0x${expected.toString(16)}ULL) return 1; }`;
          const nan =
            bits === 32
              ? (expected & 0x7fffffffn) > 0x7f800000n
              : (expected & 0x7fffffffffffffffn) > 0x7ff0000000000000n;
          return `{ uint${bits}_t bits = 0x${input.toString(16)}ULL, observed; ${bits === 32 ? 'float' : 'double'} input, result; memcpy(&input, &bits, sizeof(input)); result = ${name}(input); memcpy(&observed, &result, sizeof(result)); if (${nan ? '!isnan(result)' : `observed != 0x${expected.toString(16)}ULL`}) return 1; }`;
        });
        const path = join(directory, 'native.c'),
          binary = join(directory, 'native');
        writeFileSync(
          path,
          `#include <stdint.h>\n#include <math.h>\n#include <string.h>\n${output.emission.text}\nint main(void) { ${checks.join('\n')} return 0; }\n`,
        );
        execFileSync('clang', ['-std=c11', '-O2', '-ffp-contract=off', path, '-o', binary]);
        execFileSync(binary);
      }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Integer arguments in their SysV registers, an f64 result from `make`,
 * returned and, with `store`, also stored through one more pointer argument. */
function integers(
  name: string,
  count: number,
  make: (block: BlockBuilder, inputs: readonly Value[], fp: DataType) => Value,
  store: boolean | 'observed' = false,
): Fixture {
  const abi = sysvAMD64Abi,
    fp: DataType = { kind: 'float', bits: 64 },
    parameters = Array.from({ length: count + Number(Boolean(store)) }, () => ({
      kind: 'integer' as const,
      bits: 64,
      signed: false,
    }));
  const b = builder(`native-integers-${name}`),
    entry = b.block('entry');
  const inputs = abi
    .classifyCall({
      returns: fp,
      parameters,
      variadic: false,
      fixed_parameter_count: parameters.length,
    })
    .parameters.map(({ locations: [location] }) => {
      if (location?.kind !== 'register') throw new Error('Integer argument register required');
      return entry.readRegister(location.register);
    });
  const result = make(entry, inputs.slice(0, count), fp);
  // 'observed': an integer consumer of the result's bits observes its payload.
  if (store) {
    const bits = entry.cast('bitcast', integer(64), result);
    entry.store(
      inputs[count]!,
      store === 'observed' ? entry.int('add', bits, entry.constant(integer(64), 1n)) : bits,
    );
  }
  entry.return([result]);
  const ir = constructSSA(b.finish(entry, [fp])).value as SSAForm;
  return { ir, source: { abi, callees: [], addresses: [] } };
}

const POINTER = 0x2000n;
const zeroed = (): Map<bigint, number> =>
  new Map(Array.from({ length: 8 }, (_, i) => [POINTER + BigInt(i), 0]));
const stored = (memory: ReadonlyMap<bigint, number>): bigint =>
  Array.from(
    { length: 8 },
    (_, i) => BigInt(memory.get(POINTER + BigInt(i))!) << BigInt(8 * i),
  ).reduce((total, byte) => total | byte);

/** Source and checked views agree on every argument tuple: result and stored bits. */
function agreeIntegers(
  f: Fixture,
  language: Language,
  cases: readonly (readonly bigint[])[],
  exactStore = false,
): void {
  const source = emit(f.ir, { source: f.source }, language).emission;
  const checked = emit(f.ir, { source: f.source }, language, 'checked').emission;
  for (const args of cases) {
    const [actual, expected] = [source, checked].map((emission) => {
      const formals = emittedFormals(emission);
      return execute(
        emission,
        new Map(
          formals.flatMap((formal, index) =>
            formal.semantic_ids.map((id) => [id, args[index] ?? POINTER] as const),
          ),
        ),
        zeroed(),
      );
    });
    const label = `${language} ${args.map((value) => `0x${value.toString(16)}`).join(', ')}`;
    assert.equal(actual!.exit, expected!.exit, label);
    assert.equal(actual!.values.length, expected!.values.length, label);
    actual!.values.forEach((value, index) =>
      assert.ok(sameModuloPayload(value, expected!.values[index]!, 64), label),
    );
    // The stored bits are exact when an integer consumer observes them.
    assert.ok(
      exactStore
        ? stored(actual!.memory) === stored(expected!.memory)
        : sameModuloPayload(stored(actual!.memory), stored(expected!.memory), 64),
      label,
    );
  }
}

/** Compile the C view with clang and check each result (and stored bits)
 * against the checked view's execution. */
function clangAgrees(f: Fixture, cases: readonly (readonly bigint[])[], store: boolean): void {
  const output = emit(f.ir, { source: f.source });
  const checked = emit(f.ir, { source: f.source }, 'c-like', 'checked').emission;
  const name = output.identifiers.find((item) => item.entity_id === f.ir.id)!.identifier;
  const checks = cases.map((args) => {
    const observed = execute(
      checked,
      new Map(
        emittedFormals(checked).flatMap((formal, index) =>
          formal.semantic_ids.map((id) => [id, args[index] ?? POINTER] as const),
        ),
      ),
      zeroed(),
    );
    const expected = observed.values[0]!;
    const call = `${name}(${[...args.map((value) => `0x${value.toString(16)}ULL`), ...(store ? ['&slot'] : [])].join(', ')})`;
    const nan = (expected & 0x7fffffffffffffffn) > 0x7ff0000000000000n;
    return `{ double slot = 0, result = ${call}; uint64_t bits, kept; memcpy(&bits, &result, 8); memcpy(&kept, &slot, 8); if (${nan ? '!isnan(result)' : `bits != 0x${expected.toString(16)}ULL`}) return 1; if (${store ? 1 : 0} && ${nan ? '!isnan(slot)' : `kept != 0x${stored(observed.memory).toString(16)}ULL`}) return 2; }`;
  });
  const directory = mkdtempSync(join(tmpdir(), 'open-decomp-native-fp-nan-free-'));
  try {
    const path = join(directory, 'native.c'),
      binary = join(directory, 'native');
    writeFileSync(
      path,
      `#include <stdint.h>\n#include <math.h>\n#include <string.h>\n${output.emission.text}\nint main(void) { ${checks.join('\n')} return 0; }\n`,
    );
    execFileSync('clang', ['-std=c11', '-O2', '-ffp-contract=off', path, '-o', binary]);
    execFileSync(binary);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const U64_CASES = [[0n], [1n], [123456789n], [0x8000000000000001n], [0xffffffffffffffffn]] as const;
// 2^-30, as in brotli's PrintBytes.
const SCALE = 0x3e10000000000000n;

test('NaN-free: a u64 conversion times a literal is native even when stored', () => {
  const f = integers(
    'scaled-store',
    1,
    (block, [value], fp) =>
      block.fp('mul', block.cast('unsigned_to_float', fp, value!), block.constant(fp, SCALE)),
    true,
  );
  for (const language of LANGUAGES) {
    const { emission } = emit(f.ir, { source: f.source }, language);
    assert.doesNotMatch(emission.text, /fp_mul\(|cast_unsigned_to_float\(/, emission.text);
    const record = emission.local_validation?.find((item) => item.rule === 'fp_nan_free');
    assert.ok(record, 'fp_nan_free record');
    // The product's operands: the u64 conversion (2^64) and the literal (2^-30).
    assert.match(record.reason ?? '', /18446744073709552000, 9\.313225746154785e-10/);
    agreeIntegers(f, language, U64_CASES);
  }
  clangAgrees(f, U64_CASES, true);
});

test('NaN-free negatives: argument operands and variable divisors are payload-unobserved when stored; bits observed by integer code and bound overflows keep helpers', () => {
  // A stored product of an FP argument may be a NaN: its payload is unobserved
  // (fp_nan_payload_unobserved), so the product is native and agrees modulo
  // payload; an integer consumer of its bits keeps the helper.
  const argument = build(
    64,
    'argument-scaled',
    (block, input, fp) => block.fp('mul', input, block.constant(fp, SCALE)),
    true,
  );
  for (const language of LANGUAGES) {
    assert.doesNotMatch(
      emit(argument.ir, { source: argument.source }, language).emission.text,
      /fp_mul\(/,
    );
    agree(argument, language, 64);
  }
  // 0/0 is invalid: a stored quotient by a variable is native; the
  // conversions themselves are native.
  const quotient = integers(
    'variable-divisor',
    2,
    (block, [left, right], fp) =>
      block.fp(
        'div',
        block.cast('unsigned_to_float', fp, left!),
        block.cast('unsigned_to_float', fp, right!),
      ),
    true,
  );
  const text = emit(quotient.ir, { source: quotient.source }).emission.text;
  assert.doesNotMatch(text, /fp_div\(|cast_unsigned_to_float\(/);
  const observedQuotient = integers(
    'variable-divisor-observed',
    2,
    (block, [left, right], fp) =>
      block.fp(
        'div',
        block.cast('unsigned_to_float', fp, left!),
        block.cast('unsigned_to_float', fp, right!),
      ),
    'observed',
  );
  const observedText = emit(observedQuotient.ir, { source: observedQuotient.source }).emission.text;
  assert.match(observedText, /fp_div\(/);
  assert.doesNotMatch(observedText, /cast_unsigned_to_float\(/);
  const QUOTIENTS = [
    [0n, 0n],
    [1n, 0n],
    [6n, 3n],
  ] as const;
  for (const language of LANGUAGES) {
    agreeIntegers(quotient, language, QUOTIENTS);
    agreeIntegers(observedQuotient, language, QUOTIENTS, true);
  }
  // 2^64 * 1e300 overflows the binary64 bound: the outer product of that
  // infinity with zero is a NaN, so it keeps its helper; the inner one is native.
  const overflow = integers(
    'bound-overflow',
    1,
    (block, [value], fp) =>
      block.fp(
        'mul',
        block.fp(
          'mul',
          block.cast('unsigned_to_float', fp, value!),
          block.constant(fp, 0x7e37e43c8800759cn),
        ),
        block.constant(fp, 0n),
      ),
    'observed',
  );
  for (const language of LANGUAGES) {
    const text = emit(overflow.ir, { source: overflow.source }, language).emission.text;
    assert.equal(text.match(/fp_mul\(/g)?.length, 1, text);
    agreeIntegers(overflow, language, U64_CASES, true);
  }
});

test('integer-to-float conversions of zero- and sign-extended values convert the narrow value', () => {
  const cases: readonly [
    string,
    (block: BlockBuilder, value: Value, fp: DataType) => Value,
    readonly bigint[],
  ][] = [
    // A u32 at or above 2^31 is positive in the signed 64-bit conversion.
    [
      'zext-u32-signed',
      (block, value, fp) =>
        block.cast(
          'signed_to_float',
          fp,
          block.cast('zero_extend', integer(64), block.cast('truncate', integer(32), value)),
        ),
      [0n, 0x7fffffffn, 0x80000000n, 0x80000001n, 0xffffffffn],
    ],
    // A u16 at or above 2^15 is positive in the signed 32-bit conversion.
    [
      'zext-u16-signed',
      (block, value, fp) =>
        block.cast(
          'signed_to_float',
          fp,
          block.cast('zero_extend', integer(32), block.cast('truncate', integer(16), value)),
        ),
      [0n, 0x7fffn, 0x8000n, 0x8001n, 0xffffn],
    ],
    [
      'zext-u16-unsigned',
      (block, value, fp) =>
        block.cast(
          'unsigned_to_float',
          fp,
          block.cast('zero_extend', integer(64), block.cast('truncate', integer(16), value)),
        ),
      [0n, 0x8000n, 0xffffn],
    ],
    // A negative i32 stays negative through its sign extension.
    [
      'sext-i32-signed',
      (block, value, fp) =>
        block.cast(
          'signed_to_float',
          fp,
          block.cast('sign_extend', integer(64), block.cast('truncate', integer(32), value)),
        ),
      [0n, 0x7fffffffn, 0x80000000n, 0xffffffffn],
    ],
  ];
  // Values within the narrowed formal's declared range.
  for (const [name, make, values] of cases) {
    const f = integers(name, 1, (block, [value], fp) => make(block, value!, fp));
    const text = emit(f.ir, { source: f.source }).emission.text;
    // The conversion reads the narrow operand, not a wider reinterpretation.
    assert.doesNotMatch(text, /cast_\w+_to_float\(/, text);
    assert.doesNotMatch(
      text,
      name.startsWith('zext') ? /\(double\)\(u?int\d+_t\)/ : /\(double\)\(u?int64_t\)/,
      text,
    );
    const runs = values.map((value) => [value]);
    for (const language of LANGUAGES) agreeIntegers(f, language, runs);
    clangAgrees(f, runs, false);
  }
});

/** `a * b` of two FP arguments (xmm0, xmm1), a possibly-NaN product: stored
 * through a pointer argument, passed to `sub_4000(double)`, or both with an
 * integer consumer of the stored bits (`observed`). */
type Product = 'store' | 'call' | 'observed';
function product(bits: 32 | 64, how: Product): Fixture & { readonly call?: string } {
  const abi = sysvAMD64Abi,
    fp: DataType = { kind: 'float', bits },
    word = integer(bits),
    pointer = { kind: 'integer' as const, bits: 64, signed: false };
  const locations = abi
    .classifyCall({
      returns: fp,
      parameters: [fp, fp, pointer],
      variadic: false,
      fixed_parameter_count: 3,
    })
    .parameters.map(({ locations: [location] }) => {
      if (location?.kind !== 'register') throw new Error('Argument register required');
      return location.register;
    });
  const b = builder(`native-product-${bits}-${how}`),
    entry = b.block('entry');
  const cell = (index: number) => ({ ...locations[index]!, width_bits: bits });
  const read = (index: number): Value => entry.cast('bitcast', fp, entry.readRegister(cell(index)));
  const result = entry.fp('mul', read(0), read(1));
  const target = { image_id: image, space: 'va' as const, value: 0x4000n };
  if (how !== 'store') entry.writeRegister(cell(0), entry.cast('bitcast', word, result));
  if (how !== 'call') {
    const bitsOf = entry.cast('bitcast', word, result);
    entry.store(
      entry.readRegister(locations[2]!),
      how === 'observed' ? entry.int('add', bitsOf, entry.constant(word, 1n)) : bitsOf,
    );
  }
  if (how !== 'store')
    entry.call({ kind: 'direct', address: target }, [], [], abi.unknown_call_clobbers);
  entry.return([]);
  const ir = constructSSA(b.finish(entry, [])).value as SSAForm;
  const call = ir.blocks[0]!.instructions.find((node) => node.kind === 'call');
  const source = {
    abi,
    callees: [] as [],
    addresses: [] as [],
    ...(call && {
      call_argument_signatures: new Map([
        [
          call.id,
          {
            returns: { kind: 'void' },
            parameters: [fp],
            variadic: false,
            fixed_parameter_count: 1,
            argument_list_complete: true,
          } as const,
        ],
      ]),
    }),
  };
  return { ir, source };
}

/** The IEEE product of two same-width operands, from JS double arithmetic
 * (exact for binary32 inputs, then rounded once). */
function multiplied(bits: 32 | 64, left: bigint, right: bigint): bigint {
  const view = new DataView(new ArrayBuffer(8));
  const decode = (value: bigint): number => {
    if (bits === 32) {
      view.setUint32(0, Number(value));
      return view.getFloat32(0);
    }
    view.setBigUint64(0, value);
    return view.getFloat64(0);
  };
  const result = decode(left) * decode(right);
  if (bits === 32) {
    view.setFloat32(0, result);
    return BigInt(view.getUint32(0));
  }
  view.setFloat64(0, result);
  return view.getBigUint64(0);
}

for (const bits of [32, 64] as const)
  for (const language of LANGUAGES)
    for (const how of ['store', 'call', 'observed'] as const)
      test(`${language}: FP${bits} product ${how === 'store' ? 'stored to caller memory' : how === 'call' ? 'passed to a call' : 'passed to a call and added as an integer'} (fp_nan_payload_unobserved)`, () => {
        const f = product(bits, how);
        const { emission } = emit(f.ir, { source: f.source }, language);
        // Python binary32 arithmetic always keeps its helper.
        const operator = !(language === 'python-like' && bits === 32);
        const premise = (emission.requirements ?? []).some(
          (item) =>
            item.kind === 'abi_conformance' &&
            item.explanation.includes('NaN payloads are unspecified'),
        );
        if (how === 'observed') assert.match(emission.text, /fp_mul\(/, emission.text);
        else {
          assert.equal(/fp_mul\(/.test(emission.text), !operator, emission.text);
          // Python binary32 prints its helper whatever the premise records.
          if (operator) assert.ok(premise, emission.text);
        }
        if (how === 'observed') assert.equal(premise, false, emission.text);
        const checked = emit(f.ir, { source: f.source }, language, 'checked').emission;
        // The checked view never passes the product (its call arguments are
        // unknown) but keeps the helper wherever it stores the product.
        if (how !== 'call') assert.match(checked.text, /fp_mul\(/, 'checked view keeps the helper');
        const cases = FP_CASES[bits];
        for (const left of cases)
          for (const right of cases) {
            const label = `${language} ${bits} ${how} 0x${left.toString(16)} * 0x${right.toString(16)}`;
            const expected = multiplied(bits, left, right);
            const inputs = (emitted: typeof emission): Map<string, bigint> =>
              new Map(
                emittedFormals(emitted).flatMap((formal, index) =>
                  formal.semantic_ids.map(
                    (id) =>
                      [
                        id,
                        how === 'call'
                          ? index === 0
                            ? left
                            : right
                          : index === 0
                            ? POINTER
                            : index === 1
                              ? left
                              : right,
                      ] as const,
                  ),
                ),
              );
            const run = (emitted: typeof emission) =>
              execute(
                emitted,
                inputs(emitted),
                zeroed(),
                0n,
                new Map(),
                new Map(),
                new Map([['sub_4000', () => []]]),
              );
            const observed = run(emission);
            if (how !== 'call') {
              const width = BigInt(bits / 8);
              const memory = Array.from(
                { length: Number(width) },
                (_, i) => BigInt(observed.memory.get(POINTER + BigInt(i)) ?? 0) << BigInt(8 * i),
              ).reduce((total, byte) => total | byte, 0n);
              const wanted = how === 'observed' ? BigInt.asUintN(bits, expected + 1n) : expected;
              assert.ok(
                how === 'observed'
                  ? memory === wanted || isNaNBits(expected, bits)
                  : sameModuloPayload(memory, wanted, bits),
                `${label}: stored 0x${memory.toString(16)}`,
              );
            }
            if (how !== 'store') {
              const argument = observed.source_calls?.[0]?.arguments[0];
              assert.ok(
                argument !== undefined && sameModuloPayload(argument, expected, bits),
                `${label}: call argument 0x${argument?.toString(16)}`,
              );
            }
          }
      });
