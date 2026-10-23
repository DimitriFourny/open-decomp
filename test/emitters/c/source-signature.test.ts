import assert from 'node:assert/strict';
import test from 'node:test';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../../src/analysis/types/index.js';
import { integer, type SSAForm } from '../../../src/ir/index.js';
import { createOperationContext } from '../../../src/core/index.js';
import { structureControlFlow } from '../../../src/presentation/index.js';
import { reconstruct } from '../../../src/reconstruction/index.js';
import { LocalValidationSession } from '../../../src/reconstruction/local-validation.js';
import { projectSourceSignature } from '../../../src/reconstruction/source-signature.js';
import { builder, image, register, slice } from '../../ir/support.js';
import { emit, emittedFormals, execute } from './support.js';

const i8 = integer(8),
  i32 = integer(32),
  i64 = integer(64);
const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
const rsi = register('rsi', 64, 0, 'replace_root', 'x86_64:rsi');
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
        output.local_validation?.some((record) => record.rule === 'formal_low_slice') ?? false,
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
  test(`${language} only IEEE accesses type a floating element pointer`, () => {
    for (const mixed of [false, true]) {
      const b = builder(`signature-float-pointer-${mixed}`),
        block = b.block('entry');
      const pointer = block.readRegister(rdi);
      const loaded = block.load(
        { kind: 'float', bits: 64 },
        block.int('add', pointer, block.constant(i64, 8n)),
      );
      // Offsets 0 and 8 are contiguous elements; a lone +8 would be a record field.
      const bits = block.int(
        'add',
        block.cast('bitcast', i64, loaded),
        block.cast('bitcast', i64, block.load({ kind: 'float', bits: 64 }, pointer)),
      );
      block.return([mixed ? block.int('add', bits, block.load(integer(64), pointer)) : bits]);
      const output = emit(
        constructSSA(b.finish(block, [i64])).value as SSAForm,
        { source },
        language,
      ).emission;
      assert.equal(
        output.local_validation?.some((record) => record.rule === 'formal_pointer') ?? false,
        !mixed,
      );
      assert.equal(
        new RegExp(language === 'c-like' ? 'const double\\*' : 'pointer\\[double\\]').test(
          output.text,
        ),
        !mixed,
      );
    }
  });
  test(`${language} indexed and displaced accesses type an element pointer; mixed elements keep the integer`, () => {
    for (const mixed of [false, true]) {
      const b = builder(`signature-indexed-${mixed}`),
        block = b.block('entry');
      const pointer = block.readRegister(rdi);
      const index = block.cast(
        'zero_extend',
        i64,
        block.cast('truncate', i32, block.readRegister(rsi)),
      );
      const element = block.load(
        i32,
        block.int('add', pointer, block.int('shl', index, block.constant(i64, 2n))),
      );
      const displaced = block.load(i32, block.int('add', pointer, block.constant(i64, 8n)));
      let sum = block.int('add', element, displaced);
      if (mixed)
        sum = block.int(
          'add',
          sum,
          block.cast(
            'zero_extend',
            i32,
            block.load(i8, block.int('add', pointer, block.constant(i64, 1n))),
          ),
        );
      block.return([block.cast('zero_extend', i64, sum)]);
      const output = emit(
        constructSSA(b.finish(block, [i64])).value as SSAForm,
        { source },
        language,
      ).emission;
      assert.equal(
        output.local_validation?.some((record) => record.rule === 'formal_pointer') ?? false,
        !mixed,
      );
      assert.ok(output.local_validation?.some((record) => record.rule === 'formal_low_slice'));
      assert.match(
        output.text,
        language === 'c-like'
          ? mixed
            ? /\(uint64_t \w+, uint32_t \w+\)/
            : /\(const uint32_t\* \w+, uint32_t \w+\)/
          : mixed
            ? /\(\w+: uint64_t, \w+: uint32_t\)/
            : /\(\w+: pointer\[uint32_t\], \w+: uint32_t\)/,
      );
      if (language === 'c-like' && !mixed) {
        assert.match(output.text, /\w+\[\w+\]/);
        assert.match(output.text, /\w+\[2\]/);
        assert.ok(output.local_validation?.some((record) => record.rule === 'typed_index'));
      }
      const [base, offset] = emittedFormals(output);
      const memory = new Map(
        Array.from({ length: 16 }, (_, index) => [0x2000n + BigInt(index), 0x11 * index] as const),
      );
      // C argument passing converts the carrier to the declared formal; a
      // Python annotation does not, so its ABI-conforming caller passes the
      // presented low word itself.
      const carrier = 0xffffffff00000001n;
      const observed = execute(
        output,
        new Map([
          ...base!.semantic_ids.map((id) => [id, 0x2000n] as const),
          ...offset!.semantic_ids.map(
            (id) => [id, language === 'c-like' ? carrier : BigInt.asUintN(32, carrier)] as const,
          ),
        ]),
        memory,
      );
      const word = (address: number): bigint =>
        BigInt(memory.get(BigInt(address))!) |
        (BigInt(memory.get(BigInt(address + 1))!) << 8n) |
        (BigInt(memory.get(BigInt(address + 2))!) << 16n) |
        (BigInt(memory.get(BigInt(address + 3))!) << 24n);
      const expected = BigInt.asUintN(
        32,
        word(0x2004) + word(0x2008) + (mixed ? BigInt(memory.get(0x2001n)!) : 0n),
      );
      assert.deepEqual(observed.values, [expected]);
      assert.deepEqual(observed.memory, memory);
    }
  });
  test(`${language} a scalar element pointer needs an array-shaped lineage: lone or gapped constant offsets stay a record`, () => {
    const cases: readonly {
      name: string;
      offsets: readonly bigint[];
      indexed: boolean;
      pointer: boolean;
    }[] = [
      { name: 'lone offset', offsets: [0x10n], indexed: false, pointer: false },
      { name: 'gap after zero', offsets: [0n, 0x10n], indexed: false, pointer: false },
      { name: 'contiguous from zero', offsets: [0n, 8n, 16n], indexed: false, pointer: true },
      { name: 'single element', offsets: [0n], indexed: false, pointer: true },
      { name: 'indexed by i*8', offsets: [0x10n], indexed: true, pointer: true },
    ];
    for (const item of cases) {
      const b = builder(`signature-array-shaped-${item.name}`),
        block = b.block('entry');
      const pointer = block.readRegister(rdi);
      let sum = item.indexed
        ? block.load(
            i64,
            block.int(
              'add',
              pointer,
              block.int('mul', block.readRegister(rsi), block.constant(i64, 8n)),
            ),
          )
        : undefined;
      for (const offset of item.offsets) {
        const value = block.load(
          i64,
          offset === 0n ? pointer : block.int('add', pointer, block.constant(i64, offset)),
        );
        sum = sum ? block.int('add', sum, value) : value;
      }
      block.return([sum!]);
      const output = emit(
        constructSSA(b.finish(block, [i64])).value as SSAForm,
        { source },
        language,
      ).emission;
      const granted = output.local_validation?.some((record) => record.rule === 'formal_pointer');
      assert.equal(granted, item.pointer, item.name);
      assert.match(
        output.text,
        language === 'c-like'
          ? item.pointer
            ? /\(const uint64_t\* \w+/
            : /\(uint64_t\* \w+|\(\w*struct\w*\* \w+|\(uint64_t \w+/
          : item.pointer
            ? /\(\w+: pointer\[uint64_t\]/
            : /\(\w+: uint64_t/,
        item.name,
      );
      if (!item.pointer) assert.doesNotMatch(output.text, /\(const uint64_t\*/, item.name);
      const formals = emittedFormals(output);
      const memory = new Map<bigint, number>();
      for (let index = 0; index < 0x40; index++) memory.set(0x2000n + BigInt(index), 3 * index + 1);
      const word = (address: bigint): bigint => {
        let value = 0n;
        for (let byte = 7n; byte >= 0n; byte--)
          value = (value << 8n) | BigInt(memory.get(address + byte)!);
        return value;
      };
      const index = 2n;
      const inputs = new Map<string, bigint>([
        ...formals[0]!.semantic_ids.map((id) => [id, 0x2000n] as const),
        ...(item.indexed ? formals[1]!.semantic_ids.map((id) => [id, index] as const) : []),
      ]);
      const observed = execute(output, inputs, memory);
      let expected = item.indexed ? word(0x2000n + index * 8n) : 0n;
      for (const offset of item.offsets) expected += word(0x2000n + offset);
      assert.deepEqual(observed.values, [BigInt.asUintN(64, expected)], item.name);
      assert.deepEqual(observed.memory, memory, item.name);
    }
  });
  test(`${language} unsigned low slices narrow formals; a whole-value call argument refuses`, () => {
    for (const escape of [false, true]) {
      const b = builder(`signature-low-slice-${escape}`),
        block = b.block('entry');
      const carrier = block.readRegister(rdi);
      const masked = block.int('and', carrier, block.constant(i64, 0xffffn));
      const middle = block.cast('zero_extend', i64, block.extract(carrier, 8, 8));
      if (escape)
        block.call(
          { kind: 'direct', address: { image_id: image, space: 'va', value: 0x4000n } },
          [carrier],
          [],
          { registers: [], flags: [], memory: 'none' },
          [`evidence_${'d'.repeat(64)}`],
        );
      block.return([block.int('or', block.int('shl', masked, block.constant(i64, 40n)), middle)]);
      const output = emit(
        constructSSA(b.finish(block, [i64])).value as SSAForm,
        { source },
        language,
      ).emission;
      assert.equal(
        output.local_validation?.some((record) => record.rule === 'formal_low_slice') ?? false,
        !escape,
      );
      assert.match(
        output.text,
        new RegExp(
          language === 'c-like'
            ? `\\(${escape ? 'uint64_t' : 'uint16_t'} \\w+\\)`
            : `\\(\\w+: ${escape ? 'uint64_t' : 'uint16_t'}\\)`,
        ),
      );
      if (escape) continue;
      const [formal] = emittedFormals(output);
      const bits = 0xdeadbeefcafe1234n;
      const observed = execute(
        output,
        new Map(
          formal!.semantic_ids.map((id) => [
            id,
            language === 'c-like' ? bits : BigInt.asUintN(16, bits),
          ]),
        ),
      );
      assert.deepEqual(observed.values, [(0x1234n << 40n) | 0x12n]);
    }
  });
  test(`${language} formal uses and slot pointer types propagate through promoted frame slots`, () => {
    for (const conflict of [false, true]) {
      const abi = sysvAMD64Abi;
      const b = builder(`signature-spilled-formals-${conflict}`),
        entry = b.block('entry'),
        head = b.block('head'),
        body = b.block('body'),
        exit = b.block('exit');
      const slot = (block: typeof entry, offset: bigint) =>
        block.int('sub', block.readRegister(abi.stack_pointer), block.constant(i64, offset));
      entry.store(slot(entry, 8n), entry.readRegister(rdi));
      entry.store(slot(entry, 16n), entry.readRegister(rsi));
      entry.store(slot(entry, 24n), entry.constant(i64, 0n));
      entry.jump(head);
      const count = head.cast('truncate', i32, head.load(i64, slot(head, 16n)));
      head.branch(
        head.compare('eq', count, head.constant(i32, 0n)),
        head.edge(exit),
        head.edge(body),
      );
      const cursor = body.load(i64, slot(body, 8n));
      const byte = body.cast('zero_extend', i64, body.load(i8, cursor));
      body.store(slot(body, 24n), body.int('add', body.load(i64, slot(body, 24n)), byte));
      // A non-pointer step stored into the slot keeps its integer declaration.
      body.store(
        slot(body, 8n),
        body.int(conflict ? 'xor' : 'add', cursor, body.constant(i64, 1n)),
      );
      const remaining = body.cast('truncate', i32, body.load(i64, slot(body, 16n)));
      body.store(
        slot(body, 16n),
        body.cast('zero_extend', i64, body.int('sub', remaining, body.constant(i32, 1n))),
      );
      body.jump(head);
      exit.return([exit.load(i64, slot(exit, 24n))]);
      const ir = constructSSA(b.finish(entry, [i64])).value as SSAForm;
      const types = recoverTypes(ir, abi, createOperationContext(), {
        image_id: image,
        slice_id: slice,
        revision: 0,
      });
      const output = emit(ir, { types, source }, language).emission;
      const rules = output.local_validation?.map((record) => record.rule) ?? [];
      assert.ok(rules.includes('private_stack_promotion'));
      assert.ok(rules.includes('formal_pointer'));
      assert.ok(rules.includes('formal_low_slice'));
      assert.equal(rules.includes('slot_pointer_type'), !conflict);
      assert.match(
        output.text,
        language === 'c-like'
          ? /\(const uint8_t\* \w+, uint32_t \w+\)/
          : /\(\w+: pointer\[uint8_t\], \w+: uint32_t\)/,
      );
      if (language === 'c-like') {
        assert.equal(/^ {2}const uint8_t\* \w+;$/m.test(output.text), !conflict);
        assert.equal(/^ {2}\w+ = \(uintptr_t\)\w+;$/m.test(output.text), conflict);
      }
      const [pointer, count_] = emittedFormals(output);
      const memory = new Map([
        [0x3000n, 5],
        [0x3001n, 7],
        [0x3002n, 250],
        [0x3003n, 99],
      ]);
      const observed = execute(
        output,
        new Map([
          ...pointer!.semantic_ids.map((id) => [id, 0x3000n] as const),
          ...count_!.semantic_ids.map((id) => [id, 0x5555555500000003n] as const),
        ]),
        memory,
      );
      assert.deepEqual(observed.values, [conflict ? 17n : 262n]);
      assert.deepEqual(observed.memory, memory);
    }
  });
  test(`${language} narrow results omit undemanded high slices under the ABI requirement`, () => {
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
        const narrowed = !demand;
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
  for (let i = 0; i < 256; i++) validation.presentation(`occupied-${i}`, `site-${i}`, 'occupied');
  const projected = projectSourceSignature(
    { ...program, local_validation_session: validation },
    input,
    context,
  );
  assert.equal(projected.formal_types?.size, 0);
  assert.equal(projected.return_scalar, undefined);
  assert.equal(validation.abiConformance.length, 0);
});
