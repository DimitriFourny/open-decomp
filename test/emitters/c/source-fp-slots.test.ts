import assert from 'node:assert/strict';
import test from 'node:test';
import { darwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { windowsX64Abi } from '../../../src/abi/windows-x64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../../src/analysis/types/index.js';
import {
  createOperationContext,
  type AbiLocation,
  type AbiProfile,
  type AbiType,
} from '../../../src/core/index.js';
import { integer, type DataType, type SSAForm } from '../../../src/ir/index.js';
import {
  fpEnvironmentGuard,
  stateRegister,
  unknownClobbers,
} from '../../../src/lifters/arm64/semantics.js';
import { structureControlFlow } from '../../../src/presentation/index.js';
import { reconstruct } from '../../../src/reconstruction/index.js';
import { builder, image, slice } from '../../ir/support.js';
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

/** `uint64_t sign_flipped_bits(double x)`: the FP-bank argument's bits move to
 * the integer result register with no IEEE use. A C formal of an integer type
 * would be passed in an integer register, so the formal must still be IEEE.
 * `split` reads the argument as two 32-bit register cells. */
function bitsOfFormal(abi: AbiProfile, split: boolean) {
  const layout = abi.classifyCall({
    returns: { kind: 'integer', bits: 64, signed: false },
    parameters: [{ kind: 'float', bits: 64 }],
    variadic: false,
    fixed_parameter_count: 1,
  });
  const argument = layout.parameters[0]!.locations[0]!,
    result = layout.returns[0]!;
  assert.ok(argument.kind === 'register' && result.kind === 'register');
  const b = builder(`fp-formal-bits-${abi.id}-${split}`),
    entry = b.block('entry');
  const cell = (offset: number, width: number) =>
    entry.readRegister({
      ...argument.register,
      id: `${argument.register.root}:${offset}:${width}`,
      offset_bits: offset,
      width_bits: width,
      write_rule: 'preserve_other_bits',
    });
  const value = split ? entry.concat([cell(0, 32), cell(32, 32)]) : cell(0, 64);
  entry.writeRegister(result.register, entry.int('xor', value, entry.constant(u64, 1n << 63n)));
  entry.return([]);
  return {
    ir: constructSSA(b.finish(entry, [])).value as SSAForm,
    source: { abi, callees: [], addresses: [] },
  };
}

for (const abi of [sysvAMD64Abi, windowsX64Abi, darwinArm64Abi])
  for (const split of [false, true])
    for (const language of ['c-like', 'python-like'] as const)
      test(`${abi.id} ${language} an FP-bank formal used only as integer bits${split ? ' in two cells' : ''} is still declared double`, () => {
        const f = bitsOfFormal(abi, split);
        const { emission } = emit(f.ir, { source: f.source }, language);
        assert.match(emission.text, language === 'c-like' ? /\(double arg0\)/ : /arg0: double/);
        assert.doesNotMatch(emission.text, /uint64_t arg0\b|arg0: uint64_t/, emission.text);
        // Cell slices read the formal's bits, never a lane of a float value.
        assert.doesNotMatch(emission.text, /cast_zero_extend|cast_truncate/, emission.text);
        const formals = emittedFormals(emission);
        assert.equal(formals.length, 1);
        const input = 0x3ff8000000000000n;
        const observed = execute(emission, new Map([[formals[0]!.statement_id, input]]));
        assert.deepEqual(observed.values, [input ^ (1n << 63n)]);
        // The checked view keeps the machine-typed entry value.
        const checked = emit(f.ir, { source: f.source }, language, 'checked').emission;
        assert.doesNotMatch(checked.text, /\bdouble\b/);
      });

/** Every register argument position is consumed and the following incoming
 * stack word is read as an IEEE double: the FP result is the product of every
 * argument's bits read as double. Win64: four FP arguments, the fifth on the
 * stack; SysV: six integer-class arguments, the seventh on the stack. */
function stackFormal(abi: AbiProfile) {
  const windows = abi.id === 'windows-x64';
  const f64: DataType = { kind: 'float', bits: 64 };
  const parameters: AbiType[] = Array.from({ length: windows ? 5 : 7 }, () =>
    windows ? { kind: 'float', bits: 64 } : { kind: 'integer', bits: 64, signed: false },
  );
  const layout = abi.classifyCall({
    returns: { kind: 'float', bits: 64 },
    parameters,
    variadic: false,
    fixed_parameter_count: parameters.length,
  });
  const stack = layout.parameters.at(-1)!.locations[0]!;
  assert.ok(stack.kind === 'stack');
  const low = (location: AbiLocation | undefined) => {
    assert.ok(location?.kind === 'register');
    return {
      ...location.register,
      id: `${location.register.root}:0:64`,
      width_bits: 64,
      write_rule: 'preserve_other_bits' as const,
    };
  };
  const b = builder(`stack-formal-${abi.id}`),
    entry = b.block('entry');
  const registers = layout.parameters
    .slice(0, -1)
    .map((parameter) => entry.readRegister(low(parameter.locations[0])));
  const word = entry.load(
    u64,
    entry.int('add', entry.readRegister(abi.stack_pointer), entry.constant(u64, stack.offset)),
  );
  let product = entry.cast('bitcast', f64, word);
  for (const value of registers)
    product = entry.fp('mul', product, entry.cast('bitcast', f64, value));
  entry.writeRegister(low(layout.returns[0]), entry.cast('bitcast', u64, product));
  entry.return([]);
  const ir = constructSSA(b.finish(entry, [])).value as SSAForm;
  const types = recoverTypes(ir, abi, createOperationContext(), {
    image_id: image,
    slice_id: slice,
    revision: 0,
  });
  return { ir, source: { abi, callees: [], addresses: [] }, types };
}

const encode = (value: number): bigint => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  return view.getBigUint64(0, true);
};

for (const abi of [windowsX64Abi, sysvAMD64Abi])
  for (const language of ['c-like', 'python-like'] as const)
    test(`${abi.id} ${language} a stack word consumed only as IEEE is double exactly where the ABI keeps a double in that slot`, () => {
      const f = stackFormal(abi);
      const { emission } = emit(f.ir, { source: f.source, types: f.types }, language);
      const values = abi.id === 'windows-x64' ? [1.5, 2, 0.5, -4, 3] : [1.5, 2, 0.5, -4, 1, 1, 3];
      const formals = emittedFormals(emission);
      assert.equal(formals.length, values.length, emission.text);
      if (abi.id === 'windows-x64')
        // Win64 assigns the fifth argument's stack slot whatever its type.
        assert.doesNotMatch(emission.text, /\buint64_t\b/, emission.text);
      // SysV would pass a seventh double in xmm0, not in the stack word.
      else assert.doesNotMatch(emission.text, /\bdouble arg|arg\d: double/, emission.text);
      const observed = execute(
        emission,
        new Map(formals.map((formal, index) => [formal.statement_id, encode(values[index]!)])),
      );
      assert.deepEqual(observed.values, [encode(-18)]);
    });
