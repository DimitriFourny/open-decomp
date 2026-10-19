import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { darwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { createOperationContext, type AbiProfile } from '../../../src/core/index.js';
import { integer, type SSAForm } from '../../../src/ir/index.js';
import {
  fpEnvironmentGuard,
  stateRegister,
  unknownClobbers,
} from '../../../src/lifters/arm64/semantics.js';
import { x86FpEnvironmentGuard } from '../../../src/lifters/x86_64/semantics.js';
import { structureControlFlow } from '../../../src/presentation/index.js';
import { reconstruct } from '../../../src/reconstruction/index.js';
import { LocalValidationSession } from '../../../src/reconstruction/local-validation.js';
import { sourceFpPresentation } from '../../../src/reconstruction/source-fp.js';
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
        unknownClobbers,
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

test('repeated guard epochs retain call effects and ignore MXCSR status-only writes', () => {
  for (const abi of [darwinArm64Abi, sysvAMD64Abi])
    for (const language of ['c-like', 'python-like'] as const) {
      const call = abi.id === darwinArm64Abi.id;
      const f = fixture(abi, 64, 'mul', false, 3, false, call);
      const { emission } = emit(f.ir, { source: f.source }, language);
      assert.doesNotMatch(emission.text, /requirement_predicate\(/);
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
      assert.equal(new Set(sites.map((site) => site.state_epoch)).size, call ? 2 : 1);
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
