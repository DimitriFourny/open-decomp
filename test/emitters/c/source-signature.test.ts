import assert from 'node:assert/strict';
import test from 'node:test';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { integer, type SSAForm } from '../../../src/ir/index.js';
import { createOperationContext } from '../../../src/core/index.js';
import { structureControlFlow } from '../../../src/presentation/index.js';
import { reconstruct } from '../../../src/reconstruction/index.js';
import { LocalValidationSession } from '../../../src/reconstruction/local-validation.js';
import { projectSourceSignature } from '../../../src/reconstruction/source-signature.js';
import { builder, image, register } from '../../ir/support.js';
import { emit, emittedFormals, execute } from './support.js';

const i8 = integer(8),
  i32 = integer(32),
  i64 = integer(64);
const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
const rax = register('rax', 64, 0, 'replace_root', 'x86_64:rax');
function difference(
  store: boolean | 'unrelated' = false,
  wide = false,
  escape: boolean | 'readonly' = false,
) {
  const b = builder(`signature-difference-${store}-${wide}-${escape}`),
    block = b.block('entry');
  const pointer = block.readRegister(rdi);
  const left = block.cast('zero_extend', i32, block.load(i8, pointer));
  const right = block.cast(
    'zero_extend',
    i32,
    block.load(i8, block.int('add', pointer, block.constant(i64, 1n))),
  );
  if (store)
    block.store(
      store === 'unrelated' ? block.constant(i64, 0x3000n) : pointer,
      block.constant(i8, 7n),
    );
  if (escape)
    block.call(
      { kind: 'direct', address: { image_id: image, space: 'va', value: 0x4000n } },
      [pointer],
      [],
      {
        registers: [],
        flags: [],
        memory: escape === 'readonly' ? 'read_only' : 'unknown_read_write',
      },
      escape === 'readonly' ? [`evidence_${'c'.repeat(64)}`] : [],
    );
  const result = block.int('sub', left, right);
  const selected = block.select(
    block.compare('eq', left, block.constant(i32, 0n)),
    block.constant(i32, 0xffffffffn),
    result,
  );
  block.return([
    wide
      ? block.int('add', pointer, block.cast('zero_extend', i64, selected))
      : block.cast('zero_extend', i64, selected),
  ]);
  const ir = constructSSA(b.finish(block, [i64])).value;
  assert.equal(ir.form, 'ssa');
  return ir as SSAForm;
}
const source = { abi: sysvAMD64Abi, callees: [], addresses: [] };
for (const language of ['c-like', 'python-like'] as const) {
  test(`${language} inferred byte pointer and signed narrow result preserve memory and signed literals`, () => {
    const ir = difference(),
      output = emit(ir, { source }, language).emission;
    assert.match(
      output.text,
      language === 'c-like' ? /int32_t fn_.*\(const uint8_t\*/ : /pointer\[uint8_t\].*-> int32_t:/,
    );
    assert.match(output.text, /-1/);
    assert.ok(
      output.local_validation?.some(
        (record) => record.rule === 'formal_pointer' && record.scope.includes('read-only formal'),
      ),
    );
    assert.ok(output.local_validation?.some((record) => record.rule === 'return_low_word'));
    assert.ok(
      output.requirements?.some(
        (requirement) =>
          requirement.kind === 'abi_conformance' &&
          requirement.explanation.includes('upper result-register bits'),
      ),
    );
    const formal = emittedFormals(output)[0]!;
    for (const [a, b] of [
      [0, 255],
      [1, 255],
      [255, 1],
      [128, 128],
    ]) {
      const memory = new Map([
        [0x2000n, a!],
        [0x2001n, b!],
      ]);
      const observed = execute(
        output,
        new Map(formal.semantic_ids.map((id) => [id, 0x2000n])),
        memory,
      );
      const expected = BigInt(a === 0 ? -1 : a! - b!);
      assert.deepEqual(
        observed.values.map((value) => BigInt.asUintN(32, value)),
        [BigInt.asUintN(32, expected)],
      );
      if (language === 'python-like') assert.deepEqual(observed.values, [expected]);
      assert.deepEqual(observed.memory, memory);
      assert.deepEqual(observed.events, ['load', 'load']);
    }
    const checked = emit(ir, { source }, language, 'checked').emission;
    assert.doesNotMatch(checked.text, /const uint8_t/);
    assert.ok(!checked.local_validation?.some((record) => record.rule === 'return_low_word'));
  });
  test(`${language} writes and escaping calls qualify const per formal; high-word demand refuses return narrowing`, () => {
    const writable = emit(difference(true), { source }, language).emission;
    assert.doesNotMatch(writable.text, /const uint8_t/);
    assert.match(writable.text, language === 'c-like' ? /uint8_t\*/ : /pointer\[uint8_t\]/);
    const escaped = emit(difference(false, false, true), { source }, language).emission;
    assert.doesNotMatch(escaped.text, /const uint8_t/);
    assert.ok(
      escaped.local_validation?.some(
        (record) =>
          record.rule === 'formal_pointer' && record.scope.includes('write-capable formal'),
      ),
    );
    for (const ir of [difference('unrelated'), difference(false, false, 'readonly')]) {
      const readonly = emit(ir, { source }, language).emission;
      if (language === 'c-like') assert.match(readonly.text, /const uint8_t/);
      assert.ok(
        readonly.local_validation?.some(
          (record) => record.rule === 'formal_pointer' && record.scope.includes('read-only formal'),
        ),
      );
    }
    const demanded = emit(
      difference(),
      { source: { ...source, function_return_demands: [rax] } },
      language,
    ).emission;
    assert.ok(!demanded.local_validation?.some((record) => record.rule === 'return_low_word'));
    assert.match(demanded.text, language === 'c-like' ? /uint64_t fn_/ : /-> uint64_t:/);
    const wide = emit(difference(false, true), { source }, language).emission;
    assert.ok(!wide.local_validation?.some((record) => record.rule === 'return_low_word'));
  });
  test(`${language} low-word signed parameter requires every carrier use to discard high bits`, () => {
    for (const highUse of [false, true]) {
      const b = builder(`signature-signed-input-${highUse}`),
        block = b.block('entry');
      const carrier = block.readRegister(rdi),
        low = block.cast('truncate', i32, carrier);
      const test = block.compare('slt', low, block.constant(i32, 0n));
      const selected = block.select(test, block.constant(i32, 1n), block.constant(i32, 2n));
      const result = block.cast('zero_extend', i64, selected);
      block.return([highUse ? block.int('add', result, carrier) : result]);
      const ir = constructSSA(b.finish(block, [i64])).value as SSAForm;
      const output = emit(ir, { source }, language).emission;
      assert.equal(
        output.local_validation?.some((record) => record.rule === 'formal_low_word') ?? false,
        !highUse,
      );
      const formal = emittedFormals(output)[0]!;
      for (const value of [0n, 0x7fffffffn, 0x80000000n, 0xffffffffn]) {
        const observed = execute(output, new Map(formal.semantic_ids.map((id) => [id, value])));
        const expected = BigInt.asIntN(32, value) < 0n ? 1n : 2n;
        assert.deepEqual(observed.values, [expected + (highUse ? value : 0n)]);
      }
    }
  });
  test(`${language} signed division and signed operand selection retain their result interpretation`, () => {
    for (const operation of ['sdiv', 'wide-sdiv', 'udiv', 'select'] as const) {
      const b = builder(`signature-signed-operation-${operation}`),
        block = b.block('entry');
      const left = block.cast('truncate', i32, block.readRegister(rdi));
      const right = block.cast(
        'truncate',
        i32,
        block.readRegister(register('rsi', 64, 0, 'replace_root', 'x86_64:rsi')),
      );
      const value =
        operation === 'select'
          ? block.select(block.compare('sgt', left, right), left, right)
          : operation === 'wide-sdiv'
            ? block.cast(
                'truncate',
                i32,
                block.int(
                  'sdiv',
                  block.cast('sign_extend', i64, left),
                  block.cast('sign_extend', i64, right),
                ),
              )
            : block.int(operation, left, right);
      block.return([block.cast('zero_extend', i64, value)]);
      const output = emit(
        constructSSA(b.finish(block, [i64])).value as SSAForm,
        { source },
        language,
      ).emission;
      const signed = operation !== 'udiv';
      assert.match(
        output.text,
        new RegExp(
          language === 'c-like'
            ? `${signed ? 'int' : 'uint'}32_t fn_`
            : `-> ${signed ? 'int' : 'uint'}32_t:`,
        ),
      );
      const formals = emittedFormals(output),
        inputs = new Map<string, bigint>();
      for (const [index, formal] of formals.entries())
        for (const id of formal.semantic_ids) inputs.set(id, index === 0 ? 0xfffffffbn : 2n);
      const observed = execute(output, inputs);
      const expected =
        operation === 'sdiv' || operation === 'wide-sdiv'
          ? -2n
          : operation === 'select'
            ? 2n
            : 0x7ffffffdn;
      assert.deepEqual(
        observed.values.map((value) => BigInt.asUintN(32, value)),
        [BigInt.asUintN(32, expected)],
      );
    }
  });
  test(`${language} scalar pointer formals require one consistent observed access width`, () => {
    for (const [bits, mixed] of [
      [8, false],
      [16, false],
      [32, false],
      [64, false],
      [32, true],
    ] as const) {
      const b = builder(`signature-scalar-pointer-${bits}-${mixed}`),
        block = b.block('entry');
      const pointer = block.readRegister(rdi),
        value = block.load(integer(bits), pointer);
      if (mixed) block.load(i8, pointer);
      block.return([bits === 64 ? value : block.cast('zero_extend', i64, value)]);
      const output = emit(
        constructSSA(b.finish(block, [i64])).value as SSAForm,
        { source },
        language,
      ).emission;
      assert.equal(
        output.local_validation?.some((record) => record.rule === 'formal_pointer') ?? false,
        !mixed,
      );
      if (!mixed)
        assert.match(
          output.text,
          new RegExp(language === 'c-like' ? `const uint${bits}_t` : `pointer\\[uint${bits}_t\\]`),
        );
      const formal = emittedFormals(output)[0]!;
      const memory = new Map(
        Array.from({ length: 8 }, (_, index) => [0x2000n + BigInt(index), 255]),
      );
      const observed = execute(
        output,
        new Map(formal.semantic_ids.map((id) => [id, 0x2000n])),
        memory,
      );
      assert.deepEqual(observed.values, [(1n << BigInt(bits)) - 1n]);
      assert.deepEqual(observed.events, mixed ? ['load', 'load'] : ['load']);
    }
  });
  test(`${language} narrow results omit only undemanded zero-extension high slices`, () => {
    for (const high of [0n, 1n]) {
      const b = builder(`signature-high-result-${high}`),
        block = b.block('entry');
      const low = block.cast('truncate', i32, block.readRegister(rdi));
      const whole = block.int(
        'or',
        block.cast('zero_extend', i64, low),
        block.constant(i64, high << 32n),
      );
      block.writeRegister(rax, whole);
      block.return([low]);
      const ir = constructSSA(b.finish(block, [i32])).value as SSAForm;
      for (const demand of [false, true]) {
        const output = emit(
          ir,
          { source: { ...source, ...(demand ? { function_return_demands: [rax] } : {}) } },
          language,
        ).emission;
        const narrowed = high === 0n && !demand;
        assert.equal(
          output.local_validation?.some((record) => record.rule === 'return_low_word') ?? false,
          narrowed,
        );
        assert.equal(output.text.includes('physical_return('), !narrowed);
        const formal = emittedFormals(output)[0]!;
        assert.deepEqual(
          execute(output, new Map(formal.semantic_ids.map((id) => [id, 0xffffffffn]))).values,
          [0xffffffffn],
        );
      }
      assert.ok(
        emit(ir, { source }, language, 'checked').emission.text.includes('physical_return('),
      );
    }
  });
}

test('signature projection refuses a rewrite when presentation records are exhausted', () => {
  const context = createOperationContext();
  const structured = structureControlFlow(difference(), context).value;
  assert.ok(structured);
  const input = { function: structured, source };
  const program = reconstruct(input, context, 'source');
  const validation = new LocalValidationSession(context);
  for (let i = 0; i < 256; i++) validation.presentation('occupied', `site-${i}`, 'occupied');
  const projected = projectSourceSignature(
    { ...program, local_validation_session: validation },
    input,
    context,
  );
  assert.equal(projected.formal_types?.size, 0);
  assert.equal(projected.return_scalar, undefined);
  assert.equal(validation.abiConformance.length, 0);
});
