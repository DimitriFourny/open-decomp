import assert from 'node:assert/strict';
import test from 'node:test';
import { darwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { windowsX64Abi } from '../../../src/abi/windows-x64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { createOperationContext, type AbiProfile } from '../../../src/core/index.js';
import { integer, type DataType, type SSAForm } from '../../../src/ir/index.js';
import { structureControlFlow } from '../../../src/presentation/index.js';
import { reconstruct } from '../../../src/reconstruction/index.js';
import { LocalValidationSession } from '../../../src/reconstruction/local-validation.js';
import { projectSourceFloating } from '../../../src/reconstruction/source-signature.js';
import { builder } from '../../ir/support.js';
import { emit, emittedFormals, execute } from './support.js';

function fixture(
  abi: AbiProfile,
  bits: 32 | 64,
  integerUse = false,
  fromMemory = false,
  literal?: bigint,
) {
  const fp: DataType = { kind: 'float', bits },
    word = integer(bits);
  const location = abi.classifyCall({
    returns: fp,
    parameters: [fp],
    variadic: false,
    fixed_parameter_count: 1,
  }).parameters[0]!.locations[0]!;
  assert.equal(location.kind, 'register');
  if (location.kind !== 'register') throw new Error('FP argument carrier required');
  const b = builder(`fp-transport-${abi.id}-${bits}-${integerUse}`),
    entry = b.block('entry'),
    yes = b.block('yes'),
    no = b.block('no'),
    join = b.block('join', [word]);
  const input = entry.cast(
    'bitcast',
    fp,
    fromMemory
      ? entry.load(word, entry.constant(integer(64), 0x2000n))
      : entry.readRegister({
          ...location.register,
          id: `${location.register.root}:0:${bits}`,
          width_bits: bits,
          write_rule: 'preserve_other_bits',
        }),
  );
  entry.branch(
    entry.fpCompare('eq', input, entry.constant(fp, 0n)),
    entry.edge(yes),
    entry.edge(no),
  );
  yes.jump(join, [
    literal === undefined ? yes.cast('bitcast', word, input) : yes.constant(word, literal),
  ]);
  const negative = no.assign(fp, { kind: 'float_unary', op: 'neg', value: input });
  no.jump(join, [no.cast('bitcast', word, negative)]);
  const carried = join.parameters[0]!;
  // A narrowing integer consumer; a whole-width store is an FP write instead.
  if (integerUse)
    join.store(join.constant(integer(64), 0x1000n), join.cast('truncate', integer(8), carried));
  join.return([join.cast('bitcast', fp, carried)]);
  const ir = constructSSA(b.finish(entry, [fp])).value as SSAForm;
  const source = { abi, callees: [], addresses: [] };
  const structured = structureControlFlow(ir, createOperationContext()).value!;
  const emissionInput = { function: structured, source };
  return {
    ir,
    source,
    emissionInput,
    program: reconstruct(emissionInput, createOperationContext(), 'source'),
  };
}

for (const abi of [darwinArm64Abi, sysvAMD64Abi, windowsX64Abi])
  for (const bits of [32, 64] as const)
    for (const integerUse of [false, true])
      test(`${abi.id} FP${bits} whole-bit phi transport ${integerUse ? 'retains integer-consumer bitcasts' : 'uses native FP declarations'}`, () => {
        const f = fixture(abi, bits, integerUse);
        assert.equal(f.program.source?.return_float, bits);
        assert.ok(f.program.local_validation?.some((record) => record.rule === 'fp_source_types'));
        assert.ok(
          f.program.local_validation_session?.abiConformance.some(
            (site) => site.rule === 'fp_source_types',
          ),
        );
        for (const language of ['c-like', 'python-like'] as const) {
          const { emission } = emit(f.ir, { source: f.source }, language);
          assert.match(emission.text, bits === 32 ? /\bfloat\b/ : /\bdouble\b/);
          assert.equal(
            /return (?:cast_bitcast|__od_bitcast_)/.test(emission.text),
            integerUse,
            emission.text,
          );
          const sign = 1n << BigInt(bits - 1);
          const nan = bits === 32 ? 0x7fa12345n : 0x7ff0123456789abcn;
          for (const input of [0n, sign, nan, sign | nan]) {
            const formals = emittedFormals(emission);
            assert.equal(formals.length, 1);
            const memory = new Map(
              Array.from({ length: bits / 8 }, (_, index) => [0x1000n + BigInt(index), 0]),
            );
            const observed = execute(
              emission,
              new Map([[formals[0]!.statement_id, input]]),
              memory,
            );
            const expected = (input & ~sign) === 0n ? input : input ^ sign;
            assert.deepEqual(observed.values, [expected]);
            if (integerUse) assert.equal(observed.memory.get(0x1000n), Number(expected & 255n));
          }
          const checked = emit(f.ir, { source: f.source }, language, 'checked').emission;
          assert.doesNotMatch(checked.text, /\b(?:float|double)\b/);
        }
      });

test('FP native spelling refuses exhausted records and conflicted FP values', () => {
  const f = fixture(sysvAMD64Abi, 64);
  const context = createOperationContext(),
    validation = new LocalValidationSession(context);
  for (let i = 0; i < 256; i++) validation.presentation(`occupied-${i}`, `fp-${i}`, 'occupied');
  assert.deepEqual(
    projectSourceFloating(
      { ...f.program, local_validation_session: validation },
      f.emissionInput,
      context,
    ),
    {},
  );
  assert.equal(validation.abiConformance.length, 0);
  const conflicts = [...f.program.values.values()]
    .filter((value) => value.type.kind === 'float')
    .map((value) => ({
      subject_id: value.id,
      alternatives: [],
      evidence_ids: [],
      reason: 'incompatible_types' as const,
    }));
  const fresh = new LocalValidationSession(createOperationContext());
  assert.deepEqual(
    projectSourceFloating(
      { ...f.program, local_validation_session: fresh },
      {
        ...f.emissionInput,
        types: {
          state: 'complete',
          work: 0,
          subjects: [],
          types: [],
          associations: [],
          signatures: [],
          shapes: [],
          conflicts,
          evidence: [],
          diagnostics: [],
          calls: null,
        },
      },
      createOperationContext(),
    ),
    {},
  );
  assert.equal(fresh.abiConformance.length, 0);
});

test('native FP phi copies read IEEE-only integer memory through a native lvalue', () => {
  const f = fixture(sysvAMD64Abi, 64, false, true);
  assert.ok(f.program.local_validation?.some((record) => record.rule === 'fp_memory_access'));
  for (const language of ['c-like', 'python-like'] as const) {
    const { emission } = emit(f.ir, { source: f.source }, language);
    assert.match(emission.text, /\bdouble\b/);
    assert.match(emission.text, language === 'c-like' ? /\*\(double \*\)/ : /memory\.f64\[/);
    assert.doesNotMatch(emission.text, /__od_bitcast_|cast_bitcast\(/);
    for (const input of [0n, 0x8000000000000000n, 0x7ff0123456789abcn]) {
      const memory = new Map(
        Array.from({ length: 8 }, (_, index) => [
          0x2000n + BigInt(index),
          Number((input >> BigInt(8 * index)) & 255n),
        ]),
      );
      const expected = (input & 0x7fffffffffffffffn) === 0n ? input : input ^ 0x8000000000000000n;
      assert.deepEqual(execute(emission, new Map(), memory).values, [expected]);
      assert.equal(execute(emission).exit, 'fault');
    }
  }
});

test('literal phi inputs retain exact FP payloads rather than numeric integer conversion', () => {
  const payload = 0x7ff0123456789abcn;
  const f = fixture(sysvAMD64Abi, 64, false, false, payload);
  for (const language of ['c-like', 'python-like'] as const) {
    const { emission } = emit(f.ir, { source: f.source }, language);
    assert.match(emission.text, /bit_pattern\("ieee64_t", 64, 0x7ff0123456789abc\)/);
    assert.doesNotMatch(emission.text, /return cast_bitcast/);
    const formal = emittedFormals(emission)[0]!;
    assert.deepEqual(execute(emission, new Map([[formal.statement_id, 0n]])).values, [payload]);
  }
});
