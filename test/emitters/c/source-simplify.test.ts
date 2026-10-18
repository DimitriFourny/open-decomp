import assert from 'node:assert/strict';
import test from 'node:test';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { simplifySSA } from '../../../src/analysis/values/index.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { integer, type BlockBuilder, type SSAForm, type Value } from '../../../src/ir/index.js';
import type { EmissionResult } from '../../../src/emitters/model.js';
import { builder, register } from '../../ir/support.js';
import { emit, execute } from './support.js';

const source = { abi: new DarwinArm64Abi(), callees: [], addresses: [] };
const i8 = integer(8),
  i16 = integer(16),
  i32 = integer(32),
  i64 = integer(64);
const descriptor = (index: number) =>
  register(`arm64:x${index}`, 64, 0, 'replace_root', `arm64:x${index}`);

interface Scenario {
  readonly name: string;
  /** Returns a 64-bit value computed from the two 64-bit arguments. */
  readonly build: (entry: BlockBuilder, a: Value, b: Value) => Value;
  /** Independent integer reference for the source formula, or `unknown`. */
  readonly expected: (a: bigint, b: bigint) => bigint | 'unknown';
  /** Spellings the source view must no longer print (per dialect). */
  readonly absent?: { readonly c?: RegExp; readonly python?: RegExp };
  /** Spellings that must stay: the simplification would be inexact. */
  readonly present?: { readonly c?: RegExp; readonly python?: RegExp };
  /** Presentation rule that must be recorded in the source view, if any. */
  readonly rule?: string;
}

const lowBits = (value: bigint, bits: number): bigint => BigInt.asUintN(bits, value);
const signed = (value: bigint, bits: number): bigint => BigInt.asIntN(bits, value);
const zero = (entry: BlockBuilder, type = i64) => entry.constant(type, 0n);

const scenarios: readonly Scenario[] = [
  {
    name: 'x & x (test instruction) is x',
    build: (entry, a) =>
      entry.cast('zero_extend', i64, entry.compare('eq', entry.int('and', a, a), zero(entry))),
    expected: (a) => (a === 0n ? 1n : 0n),
    absent: { c: /(\w+) & \1\b/, python: /(\w+) & \1\b/ },
    rule: 'integer_identity',
  },
  {
    name: 'low word x & x is the low word',
    build: (entry, a) => {
      const low = entry.extract(a, 0, 32);
      return entry.cast(
        'zero_extend',
        i64,
        entry.compare('ne', entry.int('and', low, low), entry.constant(i32, 0n)),
      );
    },
    expected: (a) => (lowBits(a, 32) === 0n ? 0n : 1n),
    absent: { c: /\(uint32_t\)arg0 & \(uint32_t\)arg0/, python: /uint32\(arg0\) & uint32\(arg0\)/ },
    rule: 'integer_identity',
  },
  {
    name: 'x | x is x',
    build: (entry, a) => entry.int('add', entry.int('or', a, a), entry.constant(i64, 1n)),
    expected: (a) => lowBits(a + 1n, 64),
    absent: { c: /(\w+) \| \1\b/, python: /(\w+) \| \1\b/ },
  },
  {
    name: 'x ^ x keeps an unknown operand',
    build: (entry) => {
      const unknown = entry.indeterminate(i64, 'unknown', 'self xor operand');
      return entry.int('xor', unknown, unknown);
    },
    expected: () => 'unknown',
    present: { c: /\^/, python: /\^/ },
  },
  {
    name: 'x - x keeps an unknown operand',
    build: (entry) => {
      const unknown = entry.indeterminate(i64, 'unknown', 'self subtraction operand');
      return entry.int('sub', unknown, unknown);
    },
    expected: () => 'unknown',
    present: { c: /-/, python: /-/ },
  },
  {
    name: 'x & x of an unknown is still unknown',
    build: (entry) => {
      const unknown = entry.indeterminate(i64, 'unknown', 'self and operand');
      return entry.int('and', unknown, unknown);
    },
    expected: () => 'unknown',
    rule: 'integer_identity',
  },
  {
    name: 'zero-high join is a zero extension',
    build: (entry, a) => entry.concat([entry.extract(a, 0, 32), zero(entry, i32)]),
    expected: (a) => lowBits(a, 32),
    absent: { c: /<< 32/, python: /<< 32/ },
  },
  {
    name: 'zero-high join of a byte lane',
    build: (entry, a) => {
      const byte = entry.extract(a, 8, 8);
      return entry.concat([byte, zero(entry, i8), zero(entry, i16), zero(entry, i32)]);
    },
    expected: (a) => lowBits(a >> 8n, 8),
    absent: { c: /<< /, python: /<< / },
  },
  {
    name: 'a join with a nonzero high part keeps its shift',
    build: (entry, a, b) => entry.concat([entry.extract(a, 0, 32), entry.extract(b, 0, 32)]),
    expected: (a, b) => lowBits(a, 32) | (lowBits(b, 32) << 32n),
  },
  {
    name: 'a zero low part keeps the shifted high part',
    build: (entry, a) => entry.concat([zero(entry, i32), entry.extract(a, 0, 32)]),
    expected: (a) => lowBits(a, 32) << 32n,
    absent: { c: /0 \|/, python: /0 \|/ },
    present: { c: /<< 32/, python: /<< 32/ },
    rule: 'zero_high_join',
  },
  {
    name: 'truncating a widened word returns the word',
    build: (entry, a) => {
      const wide = entry.cast('zero_extend', i64, entry.extract(a, 0, 32));
      return entry.cast('zero_extend', i64, entry.cast('truncate', i32, wide));
    },
    expected: (a) => lowBits(a, 32),
  },
  {
    name: 'narrowing a sign extension reads the narrow operand',
    build: (entry, a) => {
      const wide = entry.cast('sign_extend', i64, entry.extract(a, 0, 32));
      return entry.cast('zero_extend', i64, entry.cast('truncate', i16, wide));
    },
    expected: (a) => lowBits(a, 16),
  },
  {
    name: 'sign extension of a truncated zero extension',
    build: (entry, a) => {
      const wide = entry.cast('zero_extend', i64, entry.extract(a, 0, 32));
      return entry.cast('sign_extend', i64, entry.extract(wide, 0, 32));
    },
    expected: (a) => lowBits(signed(lowBits(a, 32), 32), 64),
  },
  {
    name: 'sign extension of a truncated word keeps both casts',
    build: (entry, a) => entry.cast('sign_extend', i64, entry.extract(a, 0, 32)),
    expected: (a) => lowBits(signed(lowBits(a, 32), 32), 64),
    present: { c: /int32_t/ },
  },
  {
    name: 'signed compare of a sign-extended word',
    build: (entry, a) =>
      entry.cast(
        'zero_extend',
        i64,
        entry.compare('slt', entry.cast('sign_extend', i64, entry.extract(a, 0, 32)), zero(entry)),
      ),
    expected: (a) => (signed(lowBits(a, 32), 32) < 0n ? 1n : 0n),
    present: { c: /int(32|64)_t/ },
  },
  {
    name: 'signed compare of a zero-extended word is never negative',
    build: (entry, a, b) =>
      entry.cast(
        'zero_extend',
        i64,
        entry.compare(
          'slt',
          entry.cast('zero_extend', i64, entry.extract(a, 0, 32)),
          entry.cast('zero_extend', i64, entry.extract(b, 0, 32)),
        ),
      ),
    expected: (a, b) => (lowBits(a, 32) < lowBits(b, 32) ? 1n : 0n),
    present: { c: /int64_t/ },
  },
  {
    name: 'signed compare of low words uses the 32-bit sign',
    build: (entry, a, b) =>
      entry.cast(
        'zero_extend',
        i64,
        entry.compare('slt', entry.extract(a, 0, 32), entry.extract(b, 0, 32)),
      ),
    expected: (a, b) => (signed(lowBits(a, 32), 32) < signed(lowBits(b, 32), 32) ? 1n : 0n),
    present: { c: /int32_t/ },
  },
  {
    name: 'unsigned compare of a widened word and a full word',
    build: (entry, a, b) =>
      entry.cast(
        'zero_extend',
        i64,
        entry.compare('ult', entry.cast('zero_extend', i64, entry.extract(a, 0, 32)), b),
      ),
    expected: (a, b) => (lowBits(a, 32) < b ? 1n : 0n),
  },
  {
    name: 'a mask holding the whole narrow operand is dropped',
    build: (entry, a) =>
      entry.int(
        'and',
        entry.cast('zero_extend', i64, entry.extract(a, 0, 16)),
        entry.constant(i64, 0xffffn),
      ),
    expected: (a) => lowBits(a, 16),
    absent: { c: /& 0xffff/, python: /& 0xffff/ },
    rule: 'redundant_mask',
  },
  {
    name: 'a mask narrower than the operand stays',
    build: (entry, a) =>
      entry.int(
        'and',
        entry.cast('zero_extend', i64, entry.extract(a, 0, 32)),
        entry.constant(i64, 0xffffn),
      ),
    expected: (a) => lowBits(a, 16),
    present: { c: /0xffff/, python: /0xffff/ },
  },
  {
    name: 'a mask that clears bits of a signed-looking low word stays',
    build: (entry, a) =>
      entry.int(
        'and',
        entry.cast('sign_extend', i64, entry.extract(a, 0, 32)),
        entry.constant(i64, 0xffffffffn),
      ),
    expected: (a) => lowBits(a, 32),
  },
  {
    name: 'adding all-ones is subtracting one',
    build: (entry, a) => entry.int('add', a, entry.constant(i64, 0xffffffffffffffffn)),
    expected: (a) => lowBits(a - 1n, 64),
    absent: { c: /0xffffffffffffffff/, python: /0xffffffffffffffff/ },
    present: { c: /- 1\b/, python: /- 1\b/ },
    rule: 'negative_addend',
  },
  {
    name: 'adding a large constant on the left is subtracting its magnitude',
    build: (entry, a) => entry.int('add', entry.constant(i64, 0xffffffffffff000fn), a),
    expected: (a) => lowBits(a + 0xffffffffffff000fn, 64),
    absent: { c: /0xffffffffffff000f/, python: /0xffffffffffff000f/ },
    present: { c: /- 0xfff1/, python: /- 0xfff1/ },
    rule: 'negative_addend',
  },
  {
    name: 'adding half the range keeps the addition',
    build: (entry, a) => entry.int('add', a, entry.constant(i64, 0x8000000000000000n)),
    expected: (a) => lowBits(a + 0x8000000000000000n, 64),
    present: { c: /\+ 0x8000000000000000/, python: /\+ 0x8000000000000000/ },
  },
  {
    name: 'adding all-ones to a word wraps at 32 bits',
    build: (entry, a) =>
      entry.cast(
        'zero_extend',
        i64,
        entry.int('add', entry.extract(a, 0, 32), entry.constant(i32, 0xffffffffn)),
      ),
    expected: (a) => lowBits(a - 1n, 32),
    absent: { c: /0xffffffff\b/, python: /0xffffffff\b/ },
  },
  {
    name: 'adding all-ones to a halfword wraps at 16 bits',
    build: (entry, a) =>
      entry.cast(
        'zero_extend',
        i64,
        entry.int('add', entry.extract(a, 0, 16), entry.constant(i16, 0xffffn)),
      ),
    expected: (a) => lowBits(a - 1n, 16),
  },
  {
    name: 'xor with all-ones is the complement',
    build: (entry, a) => entry.int('xor', a, entry.constant(i64, 0xffffffffffffffffn)),
    expected: (a) => lowBits(~a, 64),
    absent: { c: /\^/, python: /\^/ },
    present: { c: /~/, python: /~/ },
    rule: 'complement_xor',
  },
  {
    name: 'xor of a low word with its all-ones mask is the complement',
    build: (entry, a) =>
      entry.cast(
        'zero_extend',
        i64,
        entry.int('xor', entry.constant(i32, 0xffffffffn), entry.extract(a, 0, 32)),
      ),
    expected: (a) => lowBits(~a, 32),
    absent: { c: /\^/, python: /\^/ },
    rule: 'complement_xor',
  },
  {
    name: 'xor with a partial mask keeps the xor',
    build: (entry, a) => entry.int('xor', a, entry.constant(i64, 0xffffffffn)),
    expected: (a) => a ^ 0xffffffffn,
    present: { c: /\^/, python: /\^/ },
  },
  {
    name: 'logical negation twice is the predicate',
    build: (entry, a, b) =>
      entry.cast(
        'zero_extend',
        i64,
        entry.unary('not', entry.unary('not', entry.compare('ult', a, b))),
      ),
    expected: (a, b) => (a < b ? 1n : 0n),
    absent: { c: /!!/, python: /not not/ },
  },
  {
    name: 'logical negation once stays',
    build: (entry, a, b) =>
      entry.cast('zero_extend', i64, entry.unary('not', entry.compare('ult', a, b))),
    expected: (a, b) => (a < b ? 0n : 1n),
  },
  {
    name: 'byte lane of a widened word',
    build: (entry, a) => {
      const wide = entry.cast('zero_extend', i64, entry.extract(a, 0, 32));
      return entry.cast('zero_extend', i64, entry.cast('truncate', i8, wide));
    },
    expected: (a) => lowBits(a, 8),
  },
  {
    name: 'rotate masked to its shifted bits is a shift',
    build: (entry, a) =>
      entry.int(
        'and',
        entry.int('ror', a, entry.constant(i64, 1n)),
        entry.constant(i64, 0x7fffffffffffffffn),
      ),
    expected: (a) => a >> 1n,
    absent: { c: /bv_ror|__od_bv/, python: /bv_ror/ },
    present: { c: />> 1\b/, python: />> 1\b/ },
    rule: 'shift_idiom',
  },
  {
    name: 'rotate masked to its wrapped bits is a left shift',
    build: (entry, a) =>
      entry.int(
        'and',
        entry.int('ror', a, entry.constant(i64, 48n)),
        entry.constant(i64, 0xffffffffffff0000n),
      ),
    expected: (a) => lowBits(a << 16n, 64),
    absent: { c: /bv_ror|__od_bv/, python: /bv_ror/ },
    rule: 'shift_idiom',
  },
  {
    name: 'logical shift with the replicated sign bit is an arithmetic shift',
    build: (entry, a) =>
      entry.int(
        'or',
        entry.int(
          'and',
          entry.select(entry.extract(a, 63, 1), entry.constant(i64, -1n), entry.constant(i64, 0n)),
          entry.constant(i64, 0x8000000000000000n),
        ),
        entry.int(
          'and',
          entry.int('ror', a, entry.constant(i64, 1n)),
          entry.constant(i64, 0x7fffffffffffffffn),
        ),
      ),
    expected: (a) => lowBits(signed(a, 64) >> 1n, 64),
    absent: { c: /bv_ror|__od_bv|\? 0xffff/, python: /bv_ror|if arg0 >> 0x3f/ },
    present: { c: /\(int64_t\)arg0 >> 1/, python: /int64\(arg0\) >> 1/ },
    rule: 'shift_idiom',
  },
  {
    name: 'a real rotate stays a rotate',
    build: (entry, a) => entry.int('ror', a, entry.constant(i64, 1n)),
    expected: (a) => lowBits((a >> 1n) | (a << 63n), 64),
    present: { c: /bv_ror\(64, arg0, 1\)/, python: /bv_ror\(64, arg0, 1\)/ },
  },
];

const edge = [
  0n,
  1n,
  0xffn,
  0x7fffn,
  0x8000n,
  0xffffn,
  0x7fffffffn,
  0x80000000n,
  0xffffffffn,
  0x100000000n,
  0x7fffffffffffffffn,
  0x8000000000000000n,
  0xffffffffffffffffn,
  0x123456789abcdef0n,
];

function ssa(input: Parameters<typeof constructSSA>[0]): SSAForm {
  const converted = constructSSA(input);
  assert.equal(converted.state, 'complete');
  if (converted.value.form !== 'ssa') assert.fail('Expected SSA');
  const simplified = simplifySSA(converted.value);
  assert.equal(simplified.state, 'complete');
  return simplified.value;
}
/** Declared width and signedness of the formals and the result, from the emitted header. */
interface Signature {
  readonly formals: ReadonlyMap<string, { readonly bits: number; readonly signed: boolean }>;
  readonly result: number;
}
function signature(text: string): Signature {
  const header = text.split('\n').find((line) => /^def |\) \{$/.test(line)) ?? '';
  const formals = new Map<string, { bits: number; signed: boolean }>();
  for (const match of header.matchAll(/\b(u?)int(\d+)_t\s+(arg\d+)\b|\b(arg\d+): (u?)int(\d+)_t/g))
    formals.set((match[3] ?? match[4])!, {
      bits: Number(match[2] ?? match[6]),
      signed: (match[1] ?? match[5]) === '',
    });
  const result = /^(?:u?int(\d+)_t|bool) \w+\(|-> u?int(\d+)_t/.exec(header);
  return { formals, result: Number(result?.[1] ?? result?.[2] ?? 64) };
}
/** Entry values for the arguments; a narrowed or signed formal receives only the
 * bits (and the sign interpretation) its declared type holds. */
function inputs(ir: SSAForm, values: readonly bigint[], declared?: Signature) {
  const entry = ir.blocks.find((block) => block.id === ir.entry)!;
  const roots = new Map<string, bigint>(
    values.map((bits, index) => {
      const formal = declared?.formals.get(`arg${index}`);
      return [
        `arm64:x${index}`,
        formal?.signed
          ? BigInt.asIntN(formal.bits, bits)
          : BigInt.asUintN(formal?.bits ?? 64, bits),
      ] as [string, bigint];
    }),
  );
  const result = new Map(entry.parameters.map((value) => [value.id, 0n]));
  for (const binding of ir.register_states.find((state) => state.block === ir.entry)!.entry) {
    const root = roots.get(binding.register.root) ?? 0n;
    result.set(
      binding.value.id,
      binding.register.offset_bits || root >= 0n
        ? BigInt.asUintN(binding.register.width_bits, root >> BigInt(binding.register.offset_bits))
        : root,
    );
  }
  return result;
}
function program(scenario: Scenario): SSAForm {
  const b = builder(`source-simplify-${scenario.name}`),
    entry = b.block('entry');
  const a = entry.readRegister(descriptor(0)),
    c = entry.readRegister(descriptor(1));
  entry.return([scenario.build(entry, a, c)]);
  return ssa(b.finish(entry, [i64]));
}

for (const scenario of scenarios)
  test(`source simplification: ${scenario.name}`, () => {
    const ir = program(scenario);
    for (const language of ['c-like', 'python-like'] as const) {
      const rules = (view: 'source' | 'checked') =>
        new Set(
          (emit(ir, { source }, language, view).emission.local_validation ?? [])
            .filter((record) => record.kind === 'presentation')
            .map((record) => record.rule),
        );
      const output = emit(ir, { source }, language);
      const text = output.emission.text;
      const key = language === 'c-like' ? 'c' : 'python';
      const pattern = (spec: Scenario['absent']) => spec?.[key];
      const gone = pattern(scenario.absent),
        kept = pattern(scenario.present);
      if (gone) assert.doesNotMatch(text, gone, text);
      if (kept) assert.match(text, kept, text);
      if (scenario.rule) {
        assert.ok(rules('source').has(scenario.rule), `${scenario.rule} recorded in ${language}`);
        assert.ok(!rules('checked').has(scenario.rule), 'the checked view never simplifies');
      }
      const checked = emit(ir, { source }, language, 'checked');
      for (const view of [output, checked]) {
        const declared = signature(view.emission.text);
        for (const a of edge)
          for (const b of edge) {
            const expected = scenario.expected(
              BigInt.asUintN(declared.formals.get('arg0')?.bits ?? 64, a),
              BigInt.asUintN(declared.formals.get('arg1')?.bits ?? 64, b),
            );
            const observed = execute(view.emission, inputs(ir, [a, b], declared));
            if (expected === 'unknown') assert.equal(observed.exit, 'unknown', text);
            else {
              assert.equal(observed.exit, 'machine_return', text);
              // A narrowed result carries the low bits of the 64-bit source value.
              assert.deepEqual(
                observed.values.map((value) => BigInt.asUintN(declared.result, value)),
                [BigInt.asUintN(declared.result, expected)],
                `${text}\n a=${a} b=${b}`,
              );
            }
          }
      }
    }
  });

const presentationRules = [
  'integer_identity',
  'zero_high_join',
  'conversion_collapse',
  'double_negation',
  'redundant_mask',
  'idempotent_bitwise',
  'extension_fold',
  'complement_xor',
  'negative_addend',
  'shift_idiom',
];
const recorded = (emission: EmissionResult['emission']) =>
  (emission.local_validation ?? []).flatMap((record) =>
    record.kind === 'presentation' && record.rule && presentationRules.includes(record.rule)
      ? [record.rule]
      : [],
  );

test('the checked view never records or prints a source simplification', () => {
  for (const scenario of scenarios) {
    const ir = program(scenario);
    for (const language of ['c-like', 'python-like'] as const)
      assert.deepEqual(
        recorded(emit(ir, { source }, language, 'checked').emission),
        [],
        `${scenario.name} (${language})`,
      );
  }
});

test('collapsed conversions are recorded and keep the inner operand', () => {
  const scenario = scenarios.find((item) => item.name.startsWith('narrowing a sign extension'))!;
  const ir = program(scenario);
  const source_ = emit(ir, { source }, 'c-like').emission;
  assert.ok(recorded(source_).includes('conversion_collapse'));
  assert.doesNotMatch(source_.text, /\(uint64_t\)/);
});
