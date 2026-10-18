import assert from 'node:assert/strict';
import test from 'node:test';
import { darwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { createOperationContext, type AbiProfile } from '../../../src/core/index.js';
import { integer, type DataType, type SSAForm, type Value } from '../../../src/ir/index.js';
import type { BlockBuilder } from '../../../src/ir/builder.js';
import { structureControlFlow } from '../../../src/presentation/index.js';
import { reconstruct } from '../../../src/reconstruction/index.js';
import { LocalValidationSession } from '../../../src/reconstruction/local-validation.js';
import { projectSourceFloating } from '../../../src/reconstruction/source-signature.js';
import { builder } from '../../ir/support.js';
import { emit, emittedFormals, execute } from './support.js';

const i64 = integer(64);

/** Two integer-class pointer arguments of the ABI, read as whole registers. */
function pointers(abi: AbiProfile, block: BlockBuilder): [Value, Value] {
  const word = { kind: 'integer', bits: 64, signed: false } as const;
  const locations = abi.classifyCall({
    returns: word,
    parameters: [word, word],
    variadic: false,
    fixed_parameter_count: 2,
  }).parameters;
  const read = (index: number): Value => {
    const location = locations[index]!.locations[0]!;
    assert.equal(location.kind, 'register');
    if (location.kind !== 'register') throw new Error('register argument required');
    return block.readRegister({
      ...location.register,
      id: `${location.register.root}:0:64`,
      width_bits: 64,
      write_rule: 'replace_root',
    });
  };
  return [read(0), read(1)];
}

/** `q[0] = -p[1]` over IEEE words that the IR moves as integer bits. With
 * `mixed`, the loaded word also feeds an integer addition stored to `q[1]`,
 * and the negation is returned. */
function negate(abi: AbiProfile, bits: 32 | 64, mixed: boolean) {
  const fp: DataType = { kind: 'float', bits },
    word = integer(bits);
  const b = builder(`fp-memory-${abi.id}-${bits}-${mixed}`),
    block = b.block('entry');
  const [source, destination] = pointers(abi, block);
  const loaded = block.load(word, block.int('add', source, block.constant(i64, BigInt(bits / 8))));
  const negative = block.assign(fp, {
    kind: 'float_unary',
    op: 'neg',
    value: block.cast('bitcast', fp, loaded),
  });
  block.store(destination, block.cast('bitcast', word, negative));
  if (mixed)
    block.store(
      block.int('add', destination, block.constant(i64, BigInt(bits / 8))),
      block.int('add', loaded, block.constant(word, 1n)),
    );
  block.return(mixed ? [negative] : []);
  const ir = constructSSA(b.finish(block, mixed ? [fp] : [])).value as SSAForm;
  const input = { abi, callees: [], addresses: [] };
  return { ir, source: input };
}

const bytes = (address: bigint, value: bigint, count: number): [bigint, number][] =>
  Array.from({ length: count }, (_, index) => [
    address + BigInt(index),
    Number((value >> BigInt(8 * index)) & 255n),
  ]);
const word = (memory: ReadonlyMap<bigint, number>, address: bigint, count: number): bigint =>
  Array.from({ length: count }, (_, index) => BigInt(memory.get(address + BigInt(index))!)).reduce(
    (value, byte, index) => value | (byte << BigInt(8 * index)),
    0n,
  );

for (const abi of [sysvAMD64Abi, darwinArm64Abi])
  for (const bits of [32, 64] as const)
    for (const language of ['c-like', 'python-like'] as const)
      test(`${abi.id} ${language} FP${bits} memory read/write used only as IEEE data types native lvalues and pointers`, () => {
        const f = negate(abi, bits, false);
        const { emission } = emit(f.ir, { source: f.source }, language);
        const element = bits === 32 ? 'float' : 'double';
        assert.doesNotMatch(emission.text, /__od_bitcast_|cast_bitcast\(/);
        assert.match(
          emission.text,
          language === 'c-like'
            ? new RegExp(`const ${element}\\* \\w+, ${element}\\* \\w+`)
            : new RegExp(`pointer\\[${element}\\].*pointer\\[${element}\\]`),
        );
        const rules = emission.local_validation?.map((record) => record.rule) ?? [];
        assert.ok(rules.includes('fp_memory_access'));
        assert.ok(rules.includes('formal_pointer'));
        assert.ok(
          emission.requirements?.some((item) =>
            item.explanation.includes('IEEE binary32/binary64 bytes'),
          ),
        );
        const sign = 1n << BigInt(bits - 1);
        const nan = bits === 32 ? 0x7fa12345n : 0x7ff0123456789abcn;
        const [p, q] = emittedFormals(emission);
        for (const value of [
          0n,
          sign,
          nan,
          sign | nan,
          bits === 32 ? 0x3fc00000n : 0x3ff8000000000000n,
        ]) {
          const memory = new Map([
            ...bytes(0x2000n + BigInt(bits / 8), value, bits / 8),
            ...bytes(0x3000n, 0n, bits / 8),
          ]);
          const observed = execute(
            emission,
            new Map([
              ...p!.semantic_ids.map((id) => [id, 0x2000n] as const),
              ...q!.semantic_ids.map((id) => [id, 0x3000n] as const),
            ]),
            memory,
          );
          assert.equal(word(observed.memory, 0x3000n, bits / 8), value ^ sign, emission.text);
          assert.deepEqual(observed.events, ['load', 'store']);
        }
        const checked = emit(f.ir, { source: f.source }, language, 'checked').emission;
        assert.doesNotMatch(checked.text, /\b(?:float|double)\b|memory\.f(?:32|64)/);
      });

for (const bits of [32, 64] as const)
  for (const language of ['c-like', 'python-like'] as const)
    test(`${language} FP${bits} memory read with an integer consumer keeps the explicit integer access`, () => {
      const f = negate(sysvAMD64Abi, bits, true);
      const { emission } = emit(f.ir, { source: f.source }, language);
      const element = bits === 32 ? 'float' : 'double';
      assert.match(
        emission.text,
        language === 'c-like'
          ? new RegExp(`__od_bitcast_f${bits}_u${bits}\\(`)
          : /cast_bitcast\("ieee/,
      );
      // The mixed read stays an integer access; only the IEEE-only store is native.
      assert.match(
        emission.text,
        language === 'c-like'
          ? new RegExp(`const uint${bits}_t\\* \\w+`)
          : new RegExp(`\\w+: pointer\\[uint${bits}_t\\]`),
      );
      assert.doesNotMatch(emission.text, new RegExp(`const ${element}\\*|pointer\\[${element}\\]`));
      const sign = 1n << BigInt(bits - 1);
      const [p, q] = emittedFormals(emission);
      for (const value of [0n, sign | 5n, (1n << BigInt(bits)) - 1n]) {
        const memory = new Map([
          ...bytes(0x2000n + BigInt(bits / 8), value, bits / 8),
          ...bytes(0x3000n, 0n, bits / 4),
        ]);
        const observed = execute(
          emission,
          new Map([
            ...p!.semantic_ids.map((id) => [id, 0x2000n] as const),
            ...q!.semantic_ids.map((id) => [id, 0x3000n] as const),
          ]),
          memory,
        );
        assert.deepEqual(observed.values, [value ^ sign]);
        assert.equal(word(observed.memory, 0x3000n, bits / 8), value ^ sign);
        assert.equal(
          word(observed.memory, 0x3000n + BigInt(bits / 8), bits / 8),
          BigInt.asUintN(bits, value + 1n),
        );
      }
    });

test('integer copies without IEEE evidence stay integer; exhausted records refuse FP accesses', () => {
  const b = builder('fp-memory-copy'),
    block = b.block('entry');
  const [source, destination] = pointers(sysvAMD64Abi, block);
  block.store(destination, block.load(i64, source));
  block.return([]);
  const ir = constructSSA(b.finish(block, [])).value as SSAForm;
  for (const language of ['c-like', 'python-like'] as const) {
    const { emission } = emit(
      ir,
      { source: { abi: sysvAMD64Abi, callees: [], addresses: [] } },
      language,
    );
    assert.doesNotMatch(emission.text, /\bdouble\b|memory\.f64/);
  }
  const f = negate(sysvAMD64Abi, 64, false);
  const structured = structureControlFlow(f.ir, createOperationContext()).value!;
  const input = { function: structured, source: f.source };
  const program = reconstruct(input, createOperationContext(), 'source');
  assert.equal(program.source?.float_accesses?.size, 2);
  const context = createOperationContext(),
    validation = new LocalValidationSession(context);
  for (let i = 0; i < 256; i++) validation.presentation(`occupied-${i}`, `fp-${i}`, 'occupied');
  const refused = projectSourceFloating(
    { ...program, local_validation_session: validation },
    input,
    context,
  );
  assert.equal(refused.float_accesses, undefined);
  assert.ok(!validation.abiConformance.some((site) => site.rule === 'fp_memory_access'));
});
