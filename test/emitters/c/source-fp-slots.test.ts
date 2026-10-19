import assert from 'node:assert/strict';
import test from 'node:test';
import { darwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { createOperationContext, type AbiProfile } from '../../../src/core/index.js';
import { integer, type DataType, type SSAForm } from '../../../src/ir/index.js';
import {
  fpEnvironmentGuard,
  stateRegister,
  unknownClobbers,
} from '../../../src/lifters/arm64/semantics.js';
import { structureControlFlow } from '../../../src/presentation/index.js';
import { reconstruct } from '../../../src/reconstruction/index.js';
import { builder } from '../../ir/support.js';
import { emit, emittedFormals, execute } from './support.js';

const u64 = integer(64);

/** O0 shape: the FP argument is spilled to a frame-private slot, conditionally
 * replaced by its negation, and reloaded at the join; the reload is returned.
 * `use` selects how else the slot is touched:
 *  - `none`: only FP data flows through the slot;
 *  - `integer_load`: the reload also feeds an integer (truncating) store;
 *  - `integer_store`: an integer-class argument is also stored into the slot. */
function fixture(abi: AbiProfile, bits: 32 | 64, use: 'none' | 'integer_load' | 'integer_store') {
  const fp: DataType = { kind: 'float', bits },
    word = integer(bits);
  const location = abi.classifyCall({
    returns: fp,
    parameters: use === 'integer_store' ? [fp, { kind: 'integer', bits: 64, signed: false }] : [fp],
    variadic: false,
    fixed_parameter_count: use === 'integer_store' ? 2 : 1,
  }).parameters;
  const register = (index: number, width: number) => {
    const found = location[index]!.locations[0]!;
    assert.equal(found.kind, 'register');
    if (found.kind !== 'register') throw new Error('register argument required');
    return {
      ...found.register,
      id: `${found.register.root}:0:${width}`,
      width_bits: width,
      write_rule: 'preserve_other_bits' as const,
    };
  };
  const b = builder(`fp-slot-${abi.id}-${bits}-${use}`),
    entry = b.block('entry'),
    yes = b.block('yes'),
    join = b.block('join');
  const input = entry.cast('bitcast', fp, entry.readRegister(register(0, bits)));
  const slot = entry.int('sub', entry.readRegister(abi.stack_pointer), entry.constant(u64, 24n));
  entry.store(slot, entry.cast('bitcast', word, input));
  entry.branch(
    entry.fpCompare('eq', input, entry.constant(fp, 0n)),
    entry.edge(yes),
    entry.edge(join),
  );
  const negative = yes.assign(fp, { kind: 'float_unary', op: 'neg', value: input });
  yes.store(slot, yes.cast('bitcast', word, negative));
  if (use === 'integer_store') yes.store(slot, yes.readRegister(register(1, 64)));
  yes.jump(join);
  const reloaded = join.load(word, slot);
  if (use === 'integer_load')
    join.store(join.constant(u64, 0x1000n), join.cast('truncate', integer(8), reloaded));
  join.return([join.cast('bitcast', fp, reloaded)]);
  const ir = constructSSA(b.finish(entry, [fp])).value as SSAForm;
  const source = { abi, callees: [], addresses: [] };
  const structured = structureControlFlow(ir, createOperationContext()).value!;
  return {
    ir,
    source,
    program: reconstruct({ function: structured, source }, createOperationContext(), 'source'),
  };
}

const rules = (records: readonly { kind: string; rule?: string | undefined }[] | undefined) =>
  records?.filter((record) => record.kind === 'presentation').map((record) => record.rule) ?? [];

for (const abi of [darwinArm64Abi, sysvAMD64Abi])
  for (const bits of [32, 64] as const)
    for (const language of ['c-like', 'python-like'] as const)
      test(`${abi.id} ${language} FP${bits} promoted slot holding only FP data is a native FP local`, () => {
        const f = fixture(abi, bits, 'none');
        assert.ok(rules(f.program.local_validation).includes('fp_slot_type'));
        assert.ok(rules(f.program.local_validation).includes('private_stack_promotion'));
        assert.ok(
          f.program.local_validation_session?.abiConformance.some(
            (site) => site.rule === 'fp_slot_type',
          ),
        );
        assert.equal(f.program.source?.float_locals?.size, 1);
        const { emission } = emit(f.ir, { source: f.source }, language);
        const element = bits === 32 ? 'float' : 'double';
        assert.doesNotMatch(emission.text, /__od_bitcast_|cast_bitcast\(/, emission.text);
        assert.doesNotMatch(emission.text, /\buint(?:32|64)_t \w+;/, emission.text);
        assert.match(
          emission.text,
          language === 'c-like' ? new RegExp(`${element} \\w+;`) : new RegExp(`\\w+: ${element}`),
        );
        const sign = 1n << BigInt(bits - 1);
        const nan = bits === 32 ? 0x7fa12345n : 0x7ff0123456789abcn;
        for (const value of [
          0n,
          sign,
          nan,
          sign | nan,
          bits === 32 ? 0x3fc00000n : 0x3ff8000000000000n,
        ]) {
          const formals = emittedFormals(emission);
          assert.equal(formals.length, 1);
          const observed = execute(emission, new Map([[formals[0]!.statement_id, value]]));
          assert.deepEqual(observed.values, [(value & ~sign) === 0n ? value ^ sign : value]);
        }
        const checked = emit(f.ir, { source: f.source }, language, 'checked').emission;
        assert.doesNotMatch(checked.text, /\b(?:float|double)\b/);
        assert.ok(!rules(checked.local_validation).includes('fp_slot_type'));
      });

for (const use of ['integer_load', 'integer_store'] as const)
  for (const language of ['c-like', 'python-like'] as const)
    test(`${language} slot with ${use.replace('_', ' ')} stays an integer local`, () => {
      const f = fixture(sysvAMD64Abi, 64, use);
      assert.ok(rules(f.program.local_validation).includes('private_stack_promotion'));
      assert.ok(!rules(f.program.local_validation).includes('fp_slot_type'));
      assert.equal(f.program.source?.float_locals, undefined);
      const { emission } = emit(f.ir, { source: f.source }, language);
      assert.match(
        emission.text,
        language === 'c-like' ? /uint64_t \w+;/ : /\w+: uint64_t/,
        emission.text,
      );
      assert.match(emission.text, language === 'c-like' ? /__od_bitcast_/ : /cast_bitcast\(/);
    });

/** `return x == 0.0` guarded once by the ARM64 environment test. An opaque effect
 * either ends an unresolved-exit block (`terminal`) or precedes the comparison. */
function compareFixture(terminal: boolean) {
  const abi = darwinArm64Abi,
    fp: DataType = { kind: 'float', bits: 64 };
  const location = abi.classifyCall({
    returns: fp,
    parameters: [fp],
    variadic: false,
    fixed_parameter_count: 1,
  }).parameters[0]!.locations[0]!;
  assert.equal(location.kind, 'register');
  if (location.kind !== 'register') throw new Error('Expected FP register');
  const b = builder(`fp-terminal-effect-${terminal}`),
    entry = b.block('entry'),
    supported = b.block('supported'),
    failure = b.block('failure'),
    yes = b.block('yes'),
    other = b.block('other');
  const input = entry.cast(
    'bitcast',
    fp,
    entry.readRegister({ ...location.register, width_bits: 64 }),
  );
  const state = entry.readRegister(stateRegister('fpcr'));
  entry.branch(
    entry.compare(
      'eq',
      entry.int('and', state, entry.constant(integer(32), fpEnvironmentGuard.mask)),
      entry.constant(integer(32), 0n),
    ),
    entry.edge(supported),
    entry.edge(failure),
  );
  failure.unknown(fpEnvironmentGuard.unsupported_effect, unknownClobbers);
  failure.terminate({ kind: 'unknown', reason: fpEnvironmentGuard.unsupported_exit });
  if (!terminal) supported.unknown('Unsupported encoding', unknownClobbers);
  supported.branch(
    supported.fpCompare('eq', input, supported.constant(fp, 0n)),
    supported.edge(yes),
    supported.edge(other),
  );
  yes.return([yes.constant(integer(32), 1n)]);
  if (terminal) {
    other.unknown('Discovered block has an unresolved exit or decode gap', unknownClobbers);
    other.terminate({ kind: 'unknown', reason: 'Unresolved discovered continuation' });
  } else other.return([other.constant(integer(32), 0n)]);
  const ir = constructSSA(b.finish(entry, [integer(32)])).value as SSAForm;
  return { ir, source: { abi, callees: [], addresses: [] } };
}

for (const language of ['c-like', 'python-like'] as const) {
  test(`${language} an opaque effect ending an unresolved-exit block keeps comparisons native`, () => {
    const f = compareFixture(true);
    const { emission } = emit(f.ir, { source: f.source }, language);
    assert.doesNotMatch(emission.text, /\bfp_eq\(/, emission.text);
    assert.match(emission.text, /== 0\.0/);
    assert.ok(rules(emission.local_validation).includes('fp_terminal_effect'));
    assert.ok(rules(emission.local_validation).includes('fp_native_operations'));
    // The effect and its unresolved exit stay printed.
    assert.match(emission.text, /Discovered block has an unresolved exit or decode gap/);
  });
  test(`${language} an opaque effect before a comparison keeps the helper`, () => {
    const f = compareFixture(false);
    const { emission } = emit(f.ir, { source: f.source }, language);
    assert.match(emission.text, /\bfp_eq\(/, emission.text);
    assert.ok(!rules(emission.local_validation).includes('fp_terminal_effect'));
  });
}

/** Argument bits reinterpreted as an IEEE double: from the FP bank (`integerClass`
 * false) or from the first integer-class register. */
function formalFixture(integerClass: boolean, spill = false) {
  const abi = sysvAMD64Abi,
    fp: DataType = { kind: 'float', bits: 64 };
  const location = abi.classifyCall({
    returns: fp,
    parameters: [integerClass ? { kind: 'integer', bits: 64, signed: false } : fp],
    variadic: false,
    fixed_parameter_count: 1,
  }).parameters[0]!.locations[0]!;
  assert.equal(location.kind, 'register');
  if (location.kind !== 'register') throw new Error('Expected argument register');
  const b = builder(`fp-formal-${integerClass}`),
    entry = b.block('entry');
  let bits = entry.readRegister({ ...location.register, width_bits: 64 });
  if (spill) {
    const slot = entry.int('sub', entry.readRegister(abi.stack_pointer), entry.constant(u64, 16n));
    entry.store(slot, bits);
    bits = entry.load(u64, slot);
  }
  entry.return([
    entry.assign(fp, {
      kind: 'float',
      op: 'add',
      left: entry.cast('bitcast', fp, bits),
      right: entry.constant(fp, 0x3ff8000000000000n),
    }),
  ]);
  const ir = constructSSA(b.finish(entry, [fp])).value as SSAForm;
  return { ir, source: { abi, callees: [], addresses: [] } };
}

for (const language of ['c-like', 'python-like'] as const) {
  test(`${language} an FP-bank formal read only as IEEE data is declared double`, () => {
    const f = formalFixture(false);
    const { emission } = emit(f.ir, { source: f.source }, language);
    assert.match(emission.text, /\bdouble\b/, emission.text);
    assert.doesNotMatch(emission.text, /\buint64_t arg0\b|arg0: uint64_t/, emission.text);
    assert.doesNotMatch(emission.text, /__od_bitcast_|cast_bitcast\(/, emission.text);
  });
  test(`${language} an integer-bank formal reinterpreted as IEEE keeps its integer type`, () => {
    const f = formalFixture(true);
    const { emission } = emit(f.ir, { source: f.source }, language);
    assert.match(
      emission.text,
      language === 'c-like' ? /uint64_t arg0\b/ : /arg0: uint64_t/,
      emission.text,
    );
    assert.match(emission.text, language === 'c-like' ? /__od_bitcast_/ : /cast_bitcast\(/);
  });
}

for (const language of ['c-like', 'python-like'] as const)
  test(`${language} an FP-bank formal spilled to a private slot and reloaded only as IEEE data is declared double`, () => {
    const f = formalFixture(false, true);
    const { emission } = emit(f.ir, { source: f.source }, language);
    assert.match(emission.text, /\bdouble\b/, emission.text);
    assert.doesNotMatch(emission.text, /\buint64_t arg0\b|arg0: uint64_t/, emission.text);
    assert.doesNotMatch(emission.text, /__od_bitcast_|cast_bitcast\(/, emission.text);
  });
