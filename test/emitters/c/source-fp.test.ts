import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { darwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { windowsX64Abi } from '../../../src/abi/windows-x64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import {
  createOperationContext,
  type AbiProfile,
  type LoadedImage,
} from '../../../src/core/index.js';
import { integer, type BlockBuilder, type SSAForm, type Value } from '../../../src/ir/index.js';
import {
  fpEnvironmentGuard,
  stateRegister,
  unknownClobbers,
} from '../../../src/lifters/arm64/semantics.js';
import { x86FpEnvironmentGuard } from '../../../src/lifters/x86_64/semantics.js';
import { structureControlFlow } from '../../../src/presentation/index.js';
import { reconstruct } from '../../../src/reconstruction/index.js';
import { LocalValidationSession } from '../../../src/reconstruction/local-validation.js';
import {
  fpEnvironmentRegister,
  sourceFpPresentation,
} from '../../../src/reconstruction/source-fp.js';
import { applyEnvironmentWriters } from '../../../src/service/analysis/calls.js';
import { builder, image } from '../../ir/support.js';
import { emit, emittedFormals, execute } from './support.js';

const FP_CASES: Record<32 | 64, readonly bigint[]> = {
  32: [0n, 0x80000000n, 1n, 0x40400000n, 0x7f7fffffn, 0x7f800000n, 0x7fc12345n],
  64: [
    0n,
    0x8000000000000000n,
    1n,
    0x4008000000000000n,
    0x7fefffffffffffffn,
    0x7ff0000000000000n,
    0x7ff8123456789abcn,
  ],
};

function fixture(
  abi: AbiProfile,
  bits: 32 | 64,
  operation: 'add' | 'mul' | 'div' | 'convert' | 'integer',
  payload = false,
  guard: boolean | number = false,
  write = false,
  callBetween = false,
) {
  const fp = { kind: 'float' as const, bits };
  const location = abi.classifyCall({
    returns: fp,
    parameters: [fp],
    variadic: false,
    fixed_parameter_count: 1,
  }).parameters[0]!.locations[0]!;
  assert.equal(location.kind, 'register');
  if (location.kind !== 'register') throw new Error('Expected FP register');
  const b = builder(`native-${abi.id}-${bits}-${operation}-${payload}-${guard}-${write}`);
  const entry = b.block('entry');
  let supported = entry;
  const input = entry.cast(
    'bitcast',
    fp,
    entry.readRegister({ ...location.register, width_bits: bits }),
  );
  for (let index = 0; index < Number(guard); index++) {
    const current = supported;
    supported = b.block(`supported-${index}`);
    const failure = b.block(`failure-${index}`);
    if (callBetween && index === 1)
      current.call(
        { kind: 'direct', address: { image_id: image, space: 'va', value: 0x1234n } },
        [],
        [],
        abi.unknown_call_clobbers,
      );
    const arm = abi.id === darwinArm64Abi.id;
    const register = arm
      ? stateRegister('fpcr')
      : {
          ...stateRegister('fpcr'),
          id: 'x86_64:mxcsr[6:16]',
          root: 'x86_64:mxcsr',
          offset_bits: 6,
          width_bits: 10,
          write_rule: 'preserve_other_bits' as const,
        };
    if (write)
      current.writeRegister(
        register,
        current.constant(integer(register.width_bits), arm ? 1n << 22n : 0n),
      );
    if (!arm && index > 0)
      current.writeRegister(
        { ...register, id: 'x86_64:mxcsr[0:6]', offset_bits: 0, width_bits: 6 },
        current.constant(integer(6), 1n),
      );
    const state = current.readRegister(register);
    const condition = arm
      ? current.compare(
          'eq',
          current.int('and', state, current.constant(integer(32), fpEnvironmentGuard.mask)),
          current.constant(integer(32), 0n),
        )
      : current.compare(
          'ne',
          state,
          current.constant(integer(10), x86FpEnvironmentGuard.supported_bits),
        );
    current.branch(
      condition,
      current.edge(arm ? supported : failure),
      current.edge(arm ? failure : supported),
    );
    if (arm) failure.unknown(fpEnvironmentGuard.unsupported_effect, unknownClobbers);
    failure.terminate({
      kind: 'unknown',
      reason: arm ? fpEnvironmentGuard.unsupported_exit : x86FpEnvironmentGuard.unsupported_exit,
    });
  }
  const value =
    operation === 'integer'
      ? supported.cast('float_to_signed', integer(32), input)
      : operation === 'convert'
        ? supported.cast(
            'unsigned_to_float',
            fp,
            supported.load(integer(64), supported.constant(integer(64), 0x3000n)),
          )
        : supported.assign(fp, {
            kind: 'float',
            op: operation,
            left: input,
            right: supported.constant(fp, bits === 32 ? 0x3fc00000n : 0x3ff8000000000000n),
          });
  if (payload)
    supported.store(
      supported.constant(integer(64), 0x2000n),
      supported.cast('bitcast', integer(bits), value),
    );
  supported.return([value]);
  const ir = constructSSA(b.finish(entry, [value.type])).value as SSAForm;
  const source = {
    abi,
    callees: ir.blocks
      .flatMap((block) => block.instructions)
      .filter((node) => node.kind === 'call')
      .map((node) => ({
        call_id: node.id,
        parameters: [],
        returns: [],
        argument_list_complete: true,
        evidence_ids: [],
      })),
    addresses: [],
  };
  return { ir, source };
}

for (const abi of [darwinArm64Abi, sysvAMD64Abi]) {
  test(`${abi.id}: environment requirement replaces exact guards, not explicit writes`, () => {
    for (const write of [false, true]) {
      const f = fixture(abi, 64, 'mul', false, true, write);
      for (const language of ['c-like', 'python-like'] as const) {
        const { emission } = emit(f.ir, { source: f.source }, language);
        assert.equal(emission.text.includes('requirement_predicate('), write, emission.text);
        assert.equal(
          emission.requirements?.filter((item) => item.kind === 'fp_environment').length,
          1,
        );
        assert.equal(
          emission.requirements
            ?.find((item) => item.kind === 'fp_environment')
            ?.sites.filter((site) => site.predicate_value_id).length,
          1,
        );
        const guard = emission.local_validation?.find(
          (item) => item.rule === 'fp_environment_guard',
        );
        assert.equal(guard !== undefined, !write);
        if (guard) assert.equal(/MXCSR\[6:16\]/.test(guard.scope), abi.id === sysvAMD64Abi.id);
        const formal = emittedFormals(emission)[0]!;
        const result = execute(
          emission,
          new Map(formal.semantic_ids.map((id) => [id, 0x4000000000000000n])),
        );
        assert.equal(
          result.exit,
          write ? (abi.id === darwinArm64Abi.id ? 'unknown' : 'unknown_exit') : 'machine_return',
        );
        if (!write) assert.deepEqual(result.values, [0x4008000000000000n]);
        assert.match(
          emit(f.ir, { source: f.source }, language, 'checked').emission.text,
          /requirement_predicate\(/,
        );
      }
    }
  });
}

test('repeated guard epochs keep call effects across a preserving call and ignore MXCSR status-only writes', () => {
  for (const abi of [darwinArm64Abi, sysvAMD64Abi])
    for (const language of ['c-like', 'python-like'] as const) {
      const call = abi.id === darwinArm64Abi.id;
      const f = fixture(abi, 64, 'mul', false, 3, false, call);
      const { emission } = emit(f.ir, { source: f.source }, language);
      assert.doesNotMatch(emission.text, /requirement_predicate\(/);
      // Calls preserve the control state: no call epoch, no placeholder local.
      assert.doesNotMatch(emission.text, /unknown_value|call clobbers/);
      // One visible requirement reference, a prefix of the metadata ID.
      const references = [...emission.text.matchAll(/\b(requirement_[0-9a-f]+)…?/g)];
      assert.equal(references.length, 1);
      const environment = emission.requirements!.find((item) => item.kind === 'fp_environment')!;
      assert.ok(environment.id.startsWith(references[0]![1]!));
      assert.ok(
        environment.output_spans.some((span) =>
          emission.text.slice(span.start, span.end).includes(references[0]![1]!),
        ),
      );
      const sites = emission
        .requirements!.find((item) => item.kind === 'fp_environment')!
        .sites.filter((site) => site.predicate_value_id);
      assert.equal(sites.length, 3);
      assert.equal(new Set(sites.map((site) => site.state_epoch)).size, 1);
      const formal = emittedFormals(emission)[0]!;
      const result = execute(
        emission,
        new Map(formal.semantic_ids.map((id) => [id, 0x4000000000000000n])),
        new Map(),
        0n,
        new Map(),
        new Map(),
        new Map([['sub_1234', () => []]]),
      );
      assert.deepEqual(result.values, [0x4008000000000000n]);
      assert.deepEqual(result.events, call ? ['call'] : []);
    }
});

for (const bits of [32, 64] as const)
  for (const language of ['c-like', 'python-like'] as const)
    test(`${language}: native FP${bits} arithmetic and payload gates`, () => {
      for (const operation of ['add', 'mul', 'div', 'convert', 'integer'] as const) {
        for (const payload of [false, true]) {
          if (payload && operation === 'integer') continue;
          const f = fixture(sysvAMD64Abi, bits, operation, payload);
          const { emission } = emit(f.ir, { source: f.source }, language);
          const native =
            !payload &&
            (operation === 'integer'
              ? language === 'c-like'
              : language === 'c-like' || (bits === 64 && operation !== 'div'));
          const helper =
            operation === 'convert'
              ? 'cast_unsigned_to_float('
              : operation === 'integer'
                ? 'cast_float_to_signed('
                : `fp_${operation}(`;
          assert.equal(emission.text.includes(helper), !native, emission.text);
          const memory = new Map(Array.from({ length: 8 }, (_, i) => [0x2000n + BigInt(i), 0]));
          for (let i = 0; i < 8; i++)
            memory.set(0x3000n + BigInt(i), Number((9007199254740993n >> BigInt(i * 8)) & 255n));
          const formals = emittedFormals(emission);
          const input = bits === 32 ? 0x40400000n : 0x4008000000000000n;
          const observed = execute(
            emission,
            new Map(
              formals.flatMap((formal) => formal.semantic_ids.map((id) => [id, input] as const)),
            ),
            memory,
          );
          const expected =
            operation === 'integer'
              ? 3n
              : operation === 'convert'
                ? bits === 32
                  ? 0x5a000000n
                  : 0x4340000000000000n
                : operation === 'div'
                  ? bits === 32
                    ? 0x40000000n
                    : 0x4000000000000000n
                  : bits === 32
                    ? 0x40900000n
                    : 0x4012000000000000n;
          assert.deepEqual(observed.values, [expected], emission.text);
        }
      }
    });

test('native FP agrees with checked IEEE operations on zeros, subnormals, infinities and NaNs', () => {
  for (const bits of [32, 64] as const)
    for (const operation of ['add', 'mul', 'div', 'integer'] as const)
      for (const language of ['c-like', 'python-like'] as const) {
        const f = fixture(sysvAMD64Abi, bits, operation);
        const source = emit(f.ir, { source: f.source }, language).emission;
        const checked = emit(f.ir, { source: f.source }, language, 'checked').emission;
        for (const input of FP_CASES[bits]) {
          const run = (emission: typeof source) =>
            execute(
              emission,
              new Map(
                emittedFormals(emission).flatMap((formal) =>
                  formal.semantic_ids.map((id) => [id, input] as const),
                ),
              ),
            );
          const expected = run(checked);
          // A native C float-to-integer conversion is undefined exactly where
          // the IEEE-helper conversion is: NaN, infinity and out-of-range values.
          if (
            operation === 'integer' &&
            language === 'c-like' &&
            expected.exit !== 'machine_return'
          ) {
            assert.throws(() => run(source), /float-to-integer/);
            continue;
          }
          const actual = run(source);
          assert.equal(actual!.exit, expected!.exit);
          assert.deepEqual(actual!.values, expected!.values);
        }
      }
});

test('exact emitted native FP C executes under the disabled-contraction contract', () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-decomp-native-fp-'));
  try {
    for (const bits of [32, 64] as const)
      for (const operation of ['add', 'mul', 'div'] as const) {
        const f = fixture(sysvAMD64Abi, bits, operation);
        const output = emit(f.ir, { source: f.source });
        const checked = emit(f.ir, { source: f.source }, 'c-like', 'checked').emission;
        const name = output.identifiers.find((item) => item.entity_id === f.ir.id)!.identifier;
        const checks = FP_CASES[bits].map((input) => {
          const expected = execute(
            checked,
            new Map(
              emittedFormals(checked).flatMap((formal) =>
                formal.semantic_ids.map((id) => [id, input] as const),
              ),
            ),
          ).values[0]!;
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

test('FP presentation record exhaustion retains original guards and helpers', () => {
  const f = fixture(sysvAMD64Abi, 64, 'mul', false, true);
  const context = createOperationContext();
  const fn = structureControlFlow(f.ir, context).value!;
  const program = reconstruct({ function: fn, source: f.source }, context, 'source');
  const untyped = sourceFpPresentation(
    { ...program, source: { ...program.source!, float_values: new Map() } },
    context,
  );
  assert.equal(untyped.expressions.size, 0, 'native operators require approved native FP storage');
  const validation = new LocalValidationSession(context);
  for (let i = 0; i < 256; i++) validation.presentation(`occupied-${i}`, `fp-${i}`, 'occupied');
  const projected = sourceFpPresentation(
    { ...program, local_validation_session: validation },
    context,
  );
  assert.equal(projected.guards.size, 0);
  assert.equal(projected.expressions.size, 0);
});

/** The exact lifter environment guard of `abi` at the end of `current`: an
 * unsupported state exits through an unknown terminal, otherwise control
 * continues in the returned block. */
function environmentGuard(
  b: ReturnType<typeof builder>,
  abi: AbiProfile,
  current: BlockBuilder,
  label: string,
): BlockBuilder {
  const supported = b.block(`${label}-supported`),
    failure = b.block(`${label}-failure`);
  const arm = abi.id === darwinArm64Abi.id;
  const state = current.readRegister(environmentRegister(abi));
  const condition = arm
    ? current.compare(
        'eq',
        current.int('and', state, current.constant(integer(32), fpEnvironmentGuard.mask)),
        current.constant(integer(32), 0n),
      )
    : current.compare(
        'ne',
        state,
        current.constant(integer(10), x86FpEnvironmentGuard.supported_bits),
      );
  current.branch(
    condition,
    current.edge(arm ? supported : failure),
    current.edge(arm ? failure : supported),
  );
  if (arm) failure.unknown(fpEnvironmentGuard.unsupported_effect, unknownClobbers);
  failure.terminate({
    kind: 'unknown',
    reason: arm ? fpEnvironmentGuard.unsupported_exit : x86FpEnvironmentGuard.unsupported_exit,
  });
  return supported;
}

function environmentRegister(abi: AbiProfile) {
  return abi.id === darwinArm64Abi.id
    ? stateRegister('fpcr')
    : {
        ...stateRegister('fpcr'),
        id: 'x86_64:mxcsr[6:16]',
        root: 'x86_64:mxcsr',
        offset_bits: 6,
        width_bits: 10,
        write_rule: 'preserve_other_bits' as const,
      };
}

const CALLEE = {
  kind: 'direct' as const,
  address: { image_id: image, space: 'va' as const, value: 0x1234n },
};

function sourceOf(abi: AbiProfile, ir: SSAForm) {
  return {
    abi,
    callees: ir.blocks
      .flatMap((block) => block.instructions)
      .filter((node) => node.kind === 'call')
      .map((node) => ({
        call_id: node.id,
        parameters: [],
        returns: [],
        argument_list_complete: true,
        evidence_ids: [],
      })),
    addresses: [],
  };
}

/** `acc = x; for (i = 0; i < 3; i++) { guard; acc *= 1.5; if (!(i & 1)) f(); guard; acc += 0.25; }`
 * The call preserves the control state: both guards read the entry epoch.
 * `write` adds an explicit environment write after the call, which closes a
 * phi cycle of the loop header with a written state. */
function loopFixture(abi: AbiProfile, write: boolean) {
  const fp = { kind: 'float' as const, bits: 64 as const };
  const i32 = integer(32);
  const location = abi.classifyCall({
    returns: fp,
    parameters: [fp],
    variadic: false,
    fixed_parameter_count: 1,
  }).parameters[0]!.locations[0]!;
  if (location.kind !== 'register') throw new Error('Expected FP register');
  const b = builder(`fp-epoch-loop-${abi.id}-${write}`);
  const entry = b.block('entry'),
    head = b.block('head', [fp, i32]),
    calling = b.block('calling'),
    rejoin = b.block('rejoin'),
    exit = b.block('exit');
  entry.jump(head, [
    entry.cast('bitcast', fp, entry.readRegister({ ...location.register, width_bits: 64 })),
    entry.constant(i32, 0n),
  ]);
  const [accumulator, index] = head.parameters as [Value, Value];
  const before = environmentGuard(b, abi, head, 'before');
  const product = before.fp('mul', accumulator, before.constant(fp, 0x3ff8000000000000n));
  before.branch(
    before.compare(
      'eq',
      before.int('and', index, before.constant(i32, 1n)),
      before.constant(i32, 0n),
    ),
    before.edge(calling),
    before.edge(rejoin),
  );
  calling.call(CALLEE, [], [], abi.unknown_call_clobbers);
  if (write)
    calling.writeRegister(
      environmentRegister(abi),
      calling.constant(
        integer(environmentRegister(abi).width_bits),
        abi.id === darwinArm64Abi.id ? 1n << 22n : 0n,
      ),
    );
  calling.jump(rejoin);
  const after = environmentGuard(b, abi, rejoin, 'after');
  const sum = after.fp('add', product, after.constant(fp, 0x3fd0000000000000n));
  const next = after.int('add', index, after.constant(i32, 1n));
  after.branch(
    after.compare('ult', next, after.constant(i32, 3n)),
    after.edge(head, [sum, next]),
    after.edge(exit),
  );
  exit.return([sum]);
  const ir = constructSSA(b.finish(entry, [fp])).value as SSAForm;
  return { ir, source: sourceOf(abi, ir) };
}

/** `if (*(uint64_t *)0x3000) f(); guard; return x * 1.5;`: the call preserves
 * the control state, so the guard reads the entry epoch and nothing else reads it. */
function joinFixture(abi: AbiProfile) {
  const fp = { kind: 'float' as const, bits: 64 as const };
  const location = abi.classifyCall({
    returns: fp,
    parameters: [fp],
    variadic: false,
    fixed_parameter_count: 1,
  }).parameters[0]!.locations[0]!;
  if (location.kind !== 'register') throw new Error('Expected FP register');
  const b = builder(`fp-epoch-join-${abi.id}`);
  const entry = b.block('entry'),
    calling = b.block('calling'),
    join = b.block('join');
  const input = entry.cast(
    'bitcast',
    fp,
    entry.readRegister({ ...location.register, width_bits: 64 }),
  );
  const flag = entry.load(integer(64), entry.constant(integer(64), 0x3000n));
  entry.branch(
    entry.compare('ne', flag, entry.constant(integer(64), 0n)),
    entry.edge(calling),
    entry.edge(join),
  );
  calling.call(CALLEE, [], [], abi.unknown_call_clobbers);
  calling.jump(join);
  const supported = environmentGuard(b, abi, join, 'join');
  const product = supported.fp('mul', input, supported.constant(fp, 0x3ff8000000000000n));
  supported.return([product]);
  const ir = constructSSA(b.finish(entry, [fp])).value as SSAForm;
  return { ir, source: sourceOf(abi, ir) };
}

const bitsOf = (value: number): bigint => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0);
};

for (const abi of [darwinArm64Abi, sysvAMD64Abi])
  test(`${abi.id}: a call in a loop keeps its environment epochs assumed`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'open-decomp-fp-epoch-'));
    try {
      for (const write of [false, true]) {
        const f = loopFixture(abi, write);
        for (const language of ['c-like', 'python-like'] as const) {
          const { emission } = emit(f.ir, { source: f.source }, language);
          assert.equal(emission.text.includes('requirement_predicate('), write, emission.text);
          if (!write) assert.doesNotMatch(emission.text, /unknown_value|call clobbers/);
          assert.equal(
            emission.local_validation?.some((item) => item.rule === 'fp_environment_guard'),
            !write,
          );
          const result = execute(
            emission,
            new Map(
              emittedFormals(emission).flatMap((formal) =>
                formal.semantic_ids.map((id) => [id, bitsOf(2)] as const),
              ),
            ),
            new Map(),
            0n,
            new Map(),
            new Map(),
            new Map([['sub_1234', () => []]]),
          );
          // The retained guards read an unknown entry state: no defined result.
          if (write) assert.notEqual(result.exit, 'machine_return');
          else {
            assert.deepEqual(result.values, [bitsOf(((2 * 1.5 + 0.25) * 1.5 + 0.25) * 1.5 + 0.25)]);
            assert.deepEqual(result.events, ['call', 'call']);
          }
          assert.match(
            emit(f.ir, { source: f.source }, language, 'checked').emission.text,
            /requirement_predicate\(/,
          );
        }
        if (write) continue;
        const output = emit(f.ir, { source: f.source });
        const name = output.identifiers.find((item) => item.entity_id === f.ir.id)!.identifier;
        const path = join(directory, 'loop.c'),
          binary = join(directory, 'loop');
        writeFileSync(
          path,
          `#include <stdint.h>\n#include <math.h>\n#include <string.h>\nstatic int calls;\nvoid sub_1234(void) { calls++; }\n${output.emission.text}\nint main(void) { return !(${name}(2.0) == 7.9375 && calls == 2); }\n`,
        );
        execFileSync('clang', [
          '-std=c11',
          '-O2',
          '-ffp-contract=off',
          '-Werror=implicit-function-declaration',
          path,
          '-o',
          binary,
        ]);
        execFileSync(binary);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

for (const abi of [darwinArm64Abi, sysvAMD64Abi])
  test(`${abi.id}: an entry environment epoch read only by an omitted guard prints nothing`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'open-decomp-fp-epoch-join-'));
    try {
      const f = joinFixture(abi);
      for (const language of ['c-like', 'python-like'] as const) {
        const { emission } = emit(f.ir, { source: f.source }, language);
        assert.doesNotMatch(emission.text, /requirement_predicate|unknown_value|environment"/);
        // The preserving call adds no phi: only the entry binding is hidden,
        // and entry bindings are not listed.
        assert.equal(
          emission.local_validation?.some((item) => item.rule === 'fp_unobserved_epoch'),
          false,
        );
        for (const flag of [0n, 1n]) {
          const memory = new Map(
            Array.from({ length: 8 }, (_, i) => [0x3000n + BigInt(i), i ? 0 : Number(flag)]),
          );
          const result = execute(
            emission,
            new Map(
              emittedFormals(emission).flatMap((formal) =>
                formal.semantic_ids.map((id) => [id, bitsOf(2)] as const),
              ),
            ),
            memory,
            0n,
            new Map(),
            new Map(),
            new Map([['sub_1234', () => []]]),
          );
          assert.deepEqual(result.values, [bitsOf(3)]);
          assert.deepEqual(result.events, flag ? ['load', 'call'] : ['load']);
        }
      }
      const output = emit(f.ir, { source: f.source });
      const name = output.identifiers.find((item) => item.entity_id === f.ir.id)!.identifier;
      // It reads the flag at a fixed address: compile only, `execute()` ran it.
      const path = join(directory, 'join.c');
      writeFileSync(
        path,
        `#include <stdint.h>\n#include <math.h>\n#include <string.h>\nvoid sub_1234(void) {}\n${output.emission.text}\ndouble probe(void) { return ${name}(2.0); }\n`,
      );
      execFileSync('clang', [
        '-std=c11',
        '-fsyntax-only',
        '-ffp-contract=off',
        '-Werror=implicit-function-declaration',
        path,
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

test('an epoch web with one input that is not an entry or call epoch keeps its guards', () => {
  for (const abi of [darwinArm64Abi, sysvAMD64Abi]) {
    const f = loopFixture(abi, false);
    const context = createOperationContext();
    const fn = structureControlFlow(f.ir, context).value!;
    const program = reconstruct({ function: fn, source: f.source }, context, 'source');
    assert.equal(sourceFpPresentation(program, context).guards.size, 2);
    // The same web with an entry state that is not an environment epoch: on
    // Darwin one input of the loop's phi cycle, on SysV the guards' state.
    const entry = program.blocks.get(program.function.entry)!;
    const blocks = new Map(program.blocks);
    blocks.set(entry.id, {
      ...entry,
      register_entry: entry.register_entry.filter(
        (binding) => !['arm64:fpcr', 'x86_64:mxcsr'].includes(binding.register.root),
      ),
    });
    const projected = sourceFpPresentation({ ...program, blocks }, context);
    assert.equal(projected.guards.size, 0);
    assert.equal(projected.unobserved.size, 0);
  }
});

/** `guard; t = x * 1.5; f(); guard; return t + 0.25;` with `f` the import `name`
 * at its callable stub, after the pipeline's environment-writer step. */
function importFixture(abi: AbiProfile, name: string) {
  const fp = { kind: 'float' as const, bits: 64 as const };
  const location = abi.classifyCall({
    returns: fp,
    parameters: [fp],
    variadic: false,
    fixed_parameter_count: 1,
  }).parameters[0]!.locations[0]!;
  if (location.kind !== 'register') throw new Error('Expected FP register');
  const b = builder(`fp-import-${abi.id}-${name}`);
  const entry = b.block('entry');
  const input = entry.cast(
    'bitcast',
    fp,
    entry.readRegister({ ...location.register, width_bits: 64 }),
  );
  const before = environmentGuard(b, abi, entry, 'before');
  const product = before.fp('mul', input, before.constant(fp, 0x3ff8000000000000n));
  before.call(CALLEE, [], [], abi.unknown_call_clobbers);
  const after = environmentGuard(b, abi, before, 'after');
  after.return([after.fp('add', product, after.constant(fp, 0x3fd0000000000000n))]);
  const format = abi.id === darwinArm64Abi.id ? 'macho' : abi.id === sysvAMD64Abi.id ? 'elf' : 'pe';
  const loaded = {
    id: image,
    target: { format },
    exports: [],
    imports: [
      {
        id: `import_${name}`,
        original_name: format === 'macho' ? `_${name}` : name,
        display_name: name,
        evidence_ids: [],
        library: null,
        ordinal: null,
        slot: null,
        callable_entry: CALLEE.address,
        delayed: false,
        weak: false,
      },
    ],
  } as unknown as LoadedImage;
  const lifted = applyEnvironmentWriters(
    b.finish(entry, [fp]),
    loaded,
    [],
    [],
    abi,
    createOperationContext(),
  );
  const ir = constructSSA(lifted).value as SSAForm;
  return { ir, source: sourceOf(abi, ir) };
}

for (const abi of [darwinArm64Abi, sysvAMD64Abi, windowsX64Abi])
  test(`${abi.id}: a fesetround import keeps the guard after it; an ordinary import preserves the epoch`, () => {
    for (const language of ['c-like', 'python-like'] as const) {
      const writer = importFixture(abi, 'fesetround');
      const call = writer.ir.blocks
        .flatMap((block) => block.instructions)
        .find((node) => node.kind === 'call')!;
      // The writer call defines the control state its guard reads.
      const environment = (root: string): boolean =>
        abi.environment_writer_clobbers.some((register) => register.root === root);
      assert.ok(
        call.kind === 'call' &&
          call.register_outputs.some((binding) => environment(binding.register.root)),
      );
      const { emission } = emit(writer.ir, { source: writer.source }, language);
      // The written state is no epoch: the guard after the call (and, the
      // presentation being per function, the one before it) stays.
      assert.equal(
        [...emission.text.matchAll(/requirement_predicate\(/g)].length,
        2,
        emission.text,
      );
      assert.equal(
        emission.local_validation?.some((item) => item.rule === 'fp_environment_guard'),
        false,
      );
      const formals = new Map(
        emittedFormals(emission).flatMap((formal) =>
          formal.semantic_ids.map((id) => [id, bitsOf(2)] as const),
        ),
      );
      const calls = new Map([['sub_1234', () => []]]);
      // The retained guards read an unknown environment: no defined result.
      assert.notEqual(
        execute(emission, formals, new Map(), 0n, new Map(), new Map(), calls).exit,
        'machine_return',
      );
      const ordinary = importFixture(abi, 'puts');
      const plain = ordinary.ir.blocks
        .flatMap((block) => block.instructions)
        .find((node) => node.kind === 'call')!;
      // MXCSR status bits [0:6] are ordinary call clobbers; control bits are not.
      assert.ok(
        plain.kind === 'call' &&
          !plain.register_outputs.some(
            (binding) =>
              fpEnvironmentRegister(binding.register) || binding.register.root === 'x86_64:fpcsr',
          ),
      );
      const preserved = emit(ordinary.ir, { source: ordinary.source }, language).emission;
      assert.doesNotMatch(preserved.text, /requirement_predicate\(|unknown_value/);
      assert.equal(
        preserved.local_validation?.filter((item) => item.rule === 'fp_environment_guard').length,
        2,
      );
      const premise = preserved.requirements?.find(
        (item) =>
          item.kind === 'abi_conformance' &&
          item.explanation.includes('preserve the FP control state'),
      );
      assert.ok(premise);
      assert.equal(premise.sites.length, 1);
      const result = execute(
        preserved,
        new Map(
          emittedFormals(preserved).flatMap((formal) =>
            formal.semantic_ids.map((id) => [id, bitsOf(2)] as const),
          ),
        ),
        new Map(),
        0n,
        new Map(),
        new Map(),
        calls,
      );
      assert.deepEqual(result.values, [bitsOf(3.25)]);
      assert.deepEqual(result.events, ['call']);
      // A local callee whose summary shows a changed control state keeps the guards too.
      const summarized = emit(
        ordinary.ir,
        {
          source: {
            ...ordinary.source,
            callees: ordinary.source.callees.map((callee) => ({
              ...callee,
              fp_environment_writer: true as const,
            })),
          },
        },
        language,
      ).emission;
      assert.equal([...summarized.text.matchAll(/requirement_predicate\(/g)].length, 2);
      assert.ok(
        !summarized.requirements?.some(
          (item) =>
            item.kind === 'abi_conformance' &&
            item.explanation.includes('preserve the FP control state'),
        ),
      );
      // The checked view keeps every guard either way.
      for (const f of [writer, ordinary])
        assert.equal(
          [
            ...emit(f.ir, { source: f.source }, language, 'checked').emission.text.matchAll(
              /requirement_predicate\(/g,
            ),
          ].length,
          2,
        );
    }
  });
