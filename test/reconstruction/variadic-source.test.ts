import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationContext,
  newIdentity,
  type AbiProfile,
  type RegisterDescriptor,
} from '../../src/core/index.js';
import { darwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import { windowsX64Abi } from '../../src/abi/windows-x64/index.js';
import { sysvAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../src/analysis/types/index.js';
import { integer, type SSAForm } from '../../src/ir/index.js';
import { structureControlFlow } from '../../src/presentation/index.js';
import { reconstruct } from '../../src/reconstruction/index.js';
import type { StoredDecompilation } from '../../src/project/cache/index.js';
import { builder, image, slice } from '../ir/support.js';
import { project } from '../service/analysis/support.js';
import { acknowledgeRequirements, emit, emittedFormals, execute } from '../emitters/c/support.js';
import { declaredTypes } from './declared-support.js';

const storage = new DataView(new ArrayBuffer(8));
const doubleBits = (value: number): bigint => {
  storage.setFloat64(0, value, true);
  return storage.getBigUint64(0, true);
};
const writeWord = (memory: Map<bigint, number>, address: bigint, bits: bigint): void => {
  for (let byte = 0n; byte < 8n; byte++)
    memory.set(address + byte, Number((bits >> (8n * byte)) & 0xffn));
};
// Anonymous doubles: signed zeros, subnormals, rounding-sensitive magnitudes.
const doubles = [1.5, -0, 2 ** -1074, 2 ** 53, 1, -(2 ** 53), 0.1, -2.5, 2 ** -1022, 1e308];
const area = 0x9000n;

// Independent source oracle: fixtures/source/corpus.c fixture_variadic sums
// `count` anonymous doubles in order from +0.0 (IEEE binary64, nearest-even,
// no contraction): exactly JavaScript's sequential Number addition.
for (const [fixture, entry] of [
  ['macho-arm64-symbols', 0x1000006d0n],
  ['corpus-symbols.dll', 0x1800011b0n],
] as const)
  test(`${fixture}: fixture_variadic prints ... and walks va like the C oracle`, async (t) => {
    const p = await project(t, fixture);
    const fn = p.functions.find((candidate) => candidate.entry.value === entry);
    assert.ok(fn);
    for (const emitter of ['c-like', 'python-like'] as const) {
      const result: StoredDecompilation = p.payload(
        (await p.decompile(fn.id, { options: { emitter } })).result,
      ).result;
      const emission: StoredDecompilation['data']['emission'] = result.data.emission;
      assert.doesNotMatch(emission.text, /\bentry_sp\b/, emission.text);
      assert.match(emission.text, /\(\w+ \w+, \.\.\.\)|\(\w+: \w+, \.\.\.\)/, emission.text);
      assert.match(
        emission.text,
        emitter === 'c-like' ? /va_list va;\n\s*va_start\(va, \w+\);/ : /va = va_start\(\w+\)/,
      );
      assert.ok(
        emission.local_validation?.some(
          (record) => record.kind === 'presentation' && record.rule === 'va_start',
        ),
      );
      const formals = emittedFormals(emission);
      assert.equal(formals.length, 1, emission.text);
      for (let count = 0; count <= 9; count++) {
        const memory = new Map<bigint, number>();
        // The Win64 va_list cursor slot holds unknown bytes before va_start.
        for (let byte = -64n; byte < 0n; byte++) memory.set(area + byte, 0xa5);
        doubles
          .slice(0, count)
          .forEach((value, index) =>
            writeWord(memory, area + 8n * BigInt(index), doubleBits(value)),
          );
        const observation = execute(
          emission,
          new Map([
            [formals[0]!.statement_id, BigInt(count)],
            ['...', area],
          ]),
          memory,
          0n,
          new Map(),
          new Map([['non-argument entry register', 0n]]),
          new Map(),
          acknowledgeRequirements(emission),
        );
        const expected = doubles.slice(0, count).reduce((sum, value) => sum + value, 0);
        assert.equal(observation.exit, 'machine_return', `${emitter} ${count}`);
        assert.deepEqual(observation.values, [doubleBits(expected)], `${emitter} ${count}`);
        assert.equal(
          observation.events.filter((event) => event === 'load').length,
          count,
          'one read per anonymous argument',
        );
      }
    }
  });

const u64 = integer(64);
const location = (abi: AbiProfile, index: number): RegisterDescriptor => {
  const found = abi.classifyCall({
    returns: { kind: 'void' },
    parameters: Array.from({ length: 4 }, () => ({
      kind: 'integer' as const,
      bits: 64,
      signed: false,
    })),
    variadic: false,
    fixed_parameter_count: 4,
  }).parameters[index]!.locations[0]!;
  assert.equal(found.kind, 'register');
  return found.register;
};

/** Win64 `uint64_t f(uint64_t count, ...)` summing `count` anonymous words:
 * va_start spills rdx, r8 and r9 to their home slots (entry SP +16/+24/+32),
 * then a pointer starting at entry SP +16 walks the registers' homes and the
 * caller's stack slots (+40, ...) in one run. `variant` drops the r9 home
 * store or adds a direct use of rdx. */
function win64Fixture(variant: 'complete' | 'missing_store' | 'direct_use') {
  const abi = windowsX64Abi;
  const [rcx, rdx, r8, r9] = [0, 1, 2, 3].map((index) => location(abi, index)) as [
    RegisterDescriptor,
    RegisterDescriptor,
    RegisterDescriptor,
    RegisterDescriptor,
  ];
  const rax = abi.classifyCall({
    returns: { kind: 'integer', bits: 64, signed: false },
    parameters: [],
    variadic: false,
    fixed_parameter_count: 0,
  }).returns[0]!;
  assert.equal(rax.kind, 'register');
  const cursor = abi.unknown_call_clobbers.registers.find(
    (register) => register.root === 'x86_64:r10' && register.width_bits === 64,
  )!;
  const b = builder(`win64-variadic-${variant}`),
    entry = b.block('entry'),
    loop = b.block('loop'),
    done = b.block('done');
  const sp = entry.readRegister(abi.stack_pointer),
    count = entry.readRegister(rcx),
    homes = [rdx, r8, r9].map((register) => entry.readRegister(register));
  homes.forEach((value, index) => {
    if (variant !== 'missing_store' || index < 2)
      entry.store(entry.int('add', sp, entry.constant(u64, 16n + 8n * BigInt(index))), value);
  });
  entry.writeRegister(cursor, entry.int('add', sp, entry.constant(u64, 16n)));
  entry.writeRegister(rax.register, variant === 'direct_use' ? homes[0]! : entry.constant(u64, 0n));
  entry.branch(
    entry.compare('eq', count, entry.constant(u64, 0n)),
    entry.edge(done),
    entry.edge(loop),
  );
  const pointer = loop.readRegister(cursor),
    remaining = loop.readRegister(rcx);
  loop.writeRegister(
    rax.register,
    loop.int('add', loop.readRegister(rax.register), loop.load(u64, pointer)),
  );
  loop.writeRegister(cursor, loop.int('add', pointer, loop.constant(u64, 8n)));
  const next = loop.int('sub', remaining, loop.constant(u64, 1n));
  loop.writeRegister(rcx, next);
  loop.branch(loop.compare('ne', next, loop.constant(u64, 0n)), loop.edge(loop), loop.edge(done));
  done.return([done.readRegister(rax.register)]);
  const ir = constructSSA(b.finish(entry, [u64])).value as SSAForm;
  const types = recoverTypes(ir, abi, createOperationContext(), {
    image_id: image,
    slice_id: slice,
    revision: 0,
  });
  const extra = { types, source: { abi, callees: [], addresses: [] } };
  const structured = structureControlFlow(ir, createOperationContext());
  assert.ok(structured.value);
  return {
    ir,
    extra,
    view: (view: 'source' | 'checked') =>
      reconstruct({ function: structured.value!, ...extra }, createOperationContext(), view),
  };
}

const words = [
  0xffffffffffffffffn,
  1n,
  0x8000000000000000n,
  0x123456789abcdef0n,
  7n,
  0xfedcba9876543210n,
  0n,
];

test('windows-x64: the home stores of a va_start area are hidden and va walks registers and stack slots', () => {
  const fixture = win64Fixture('complete');
  const source = fixture.view('source');
  assert.ok(
    source.local_validation?.some(
      (record) => record.kind === 'presentation' && record.rule === 'va_start',
    ),
  );
  assert.ok(
    source.local_validation_session?.abiConformance.some(
      (site) => site.rule === 'variadic_convention',
    ),
  );
  assert.ok(
    !fixture.view('checked').local_validation?.some((record) => record.rule === 'va_start'),
  );
  for (const language of ['c-like', 'python-like'] as const) {
    const output = emit(fixture.ir, fixture.extra, language).emission;
    assert.doesNotMatch(output.text, /\bentry_sp\b/, output.text);
    assert.match(output.text, /\.\.\.\)/, output.text);
    const formals = emittedFormals(output);
    assert.equal(formals.length, 1, output.text);
    for (let count = 1; count <= words.length; count++) {
      // The area: rdx, r8 and r9 at their homes, then the caller's stack slots.
      const memory = new Map<bigint, number>();
      words.forEach((word, index) => writeWord(memory, area + 8n * BigInt(index), word));
      const observation = execute(
        output,
        new Map([
          [formals[0]!.statement_id, BigInt(count)],
          ['...', area],
        ]),
        memory,
      );
      const expected = BigInt.asUintN(
        64,
        words.slice(0, count).reduce((sum, word) => sum + word, 0n),
      );
      assert.deepEqual(observation.values, [expected], `${language} ${count}`);
      // The home stores are va_start's own effect: no store remains.
      assert.deepEqual(
        observation.events,
        Array<string>(count).fill('load'),
        `${language} ${count}`,
      );
    }
  }
});

for (const variant of ['missing_store', 'direct_use'] as const)
  test(`windows-x64: ${variant === 'missing_store' ? 'a missing home store' : 'a direct use of rdx'} leaves the entry-SP form`, () => {
    const fixture = win64Fixture(variant);
    assert.ok(
      !fixture.view('source').local_validation?.some((record) => record.rule === 'va_start'),
    );
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(fixture.ir, fixture.extra, language).emission;
      assert.match(output.text, /\bentry_sp\b/, output.text);
      assert.doesNotMatch(output.text, /\.\.\.|va_start/, output.text);
    }
  });

// SysV AMD64 (S7): fixture_variadic's va_start lowering (rsi..r9 saved, the
// al-guarded xmm0..7 saves, va_list = {8, 48, entry SP + 8, save area}) is
// va_start(frame.va, count) on a va_list frame member.
test('elf-x86_64-symbols: fixture_variadic prints ... and va_start on a va_list frame member', async (t) => {
  const p = await project(t, 'elf-x86_64-symbols');
  const fn = p.functions.find((candidate) => candidate.entry.value === 0x4019c0n);
  assert.ok(fn);
  for (const emitter of ['c-like', 'python-like'] as const) {
    const result: StoredDecompilation = p.payload(
      (await p.decompile(fn.id, { options: { emitter } })).result,
    ).result;
    const emission: StoredDecompilation['data']['emission'] = result.data.emission;
    assert.doesNotMatch(
      emission.text,
      /\bentry_sp\b|uint128_t|unknown_value\("bits8_t"/,
      emission.text,
    );
    assert.match(emission.text, /\(\w+ \w+, \.\.\.\)|\(\w+: \w+, \.\.\.\)/, emission.text);
    assert.match(emission.text, /va_start\(frame\.va, \w+\)/, emission.text);
    assert.match(emission.text, /frame\.va\[0\]\.fp_offset/, emission.text);
    assert.ok(
      emission.local_validation?.some(
        (record) => record.kind === 'presentation' && record.rule === 'va_start',
      ),
    );
    const formals = emittedFormals(emission);
    assert.equal(formals.length, 1, emission.text);
    // 13 doubles: xmm0..7 in the register save area, the rest on the stack.
    const values = [...doubles, 3.25, -7, 2 ** 60];
    const save = 0xa000n;
    for (let count = 0; count <= 12; count++) {
      const memory = new Map<bigint, number>();
      for (let byte = 0n; byte < 176n; byte++) memory.set(save + byte, 0x5a);
      values
        .slice(0, count)
        .forEach((value, index) =>
          writeWord(
            memory,
            index < 8 ? save + 48n + 16n * BigInt(index) : area + 8n * BigInt(index - 8),
            doubleBits(value),
          ),
        );
      const observation = execute(
        emission,
        new Map([
          [formals[0]!.statement_id, BigInt(count)],
          ['...', area],
          ['...registers', save],
        ]),
        memory,
        0n,
        new Map(),
        new Map(),
        new Map(),
        acknowledgeRequirements(emission),
      );
      const expected = values.slice(0, count).reduce((sum, value) => sum + value, 0);
      assert.equal(observation.exit, 'machine_return', `${emitter} ${count}`);
      assert.deepEqual(observation.values, [doubleBits(expected)], `${emitter} ${count}`);
    }
  }
});

/** SysV `uint64_t f(uint64_t count, ...)` whose body reads `va.gp_offset`
 * after the exact va_start lowering: rsi..r9 saved at R + 8i, xmm0..7 at
 * R + 48 + 16j under `al != 0`, then gp_offset/fp_offset, overflow_arg_area
 * and reg_save_area. `variant` drops the xmm7 store, adds a use of rsi, or
 * puts a call between the footprint stores. */
function sysvFixture(variant: 'complete' | 'missing_xmm' | 'rsi_use' | 'call_between') {
  const abi = sysvAMD64Abi;
  const integers = abi
    .classifyCall({
      returns: { kind: 'void' },
      parameters: Array.from({ length: 6 }, () => ({
        kind: 'integer' as const,
        bits: 64,
        signed: false,
      })),
      variadic: false,
      fixed_parameter_count: 6,
    })
    .parameters.map((parameter) => {
      const found = parameter.locations[0]!;
      assert.equal(found.kind, 'register');
      return found.register;
    });
  const vectors = abi
    .classifyCall({
      returns: { kind: 'void' },
      parameters: Array.from({ length: 8 }, () => ({ kind: 'float' as const, bits: 64 as const })),
      variadic: false,
      fixed_parameter_count: 8,
    })
    .parameters.map((parameter) => {
      const found = parameter.locations[0]!;
      assert.equal(found.kind, 'register');
      return { ...found.register, width_bits: 128 };
    });
  const al = abi.classifyCall({
    returns: { kind: 'void' },
    parameters: [],
    variadic: true,
    fixed_parameter_count: 0,
  }).implicit_register_inputs[0]!.register;
  const rax = abi.classifyCall({
    returns: { kind: 'integer', bits: 64, signed: false },
    parameters: [],
    variadic: false,
    fixed_parameter_count: 0,
  }).returns[0]!;
  assert.equal(rax.kind, 'register');
  const b = builder(`sysv-variadic-${variant}`),
    entry = b.block('entry'),
    guarded = b.block('guarded'),
    join = b.block('join');
  const sp = entry.readRegister(abi.stack_pointer);
  const at = (block: typeof entry, offset: bigint) =>
    block.int(offset < 0n ? 'sub' : 'add', sp, block.constant(u64, offset < 0n ? -offset : offset));
  const save = -184n,
    va = -216n;
  for (let index = 1; index < 6; index++)
    entry.store(at(entry, save + 8n * BigInt(index)), entry.readRegister(integers[index]!));
  const lowByte = entry.readRegister(al);
  entry.branch(
    entry.compare('eq', lowByte, entry.constant(integer(8), 0n)),
    entry.edge(join),
    entry.edge(guarded),
  );
  for (let index = 0; index < 8; index++)
    if (variant !== 'missing_xmm' || index < 7)
      guarded.store(
        at(guarded, save + 48n + 16n * BigInt(index)),
        guarded.readRegister(vectors[index]!),
      );
  guarded.jump(join);
  join.store(at(join, va + 16n), at(join, save));
  if (variant === 'call_between')
    join.call(
      { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
      [],
      [],
      abi.unknown_call_clobbers,
      [newIdentity('evidence')],
    );
  join.store(at(join, va + 8n), at(join, 8n));
  join.store(at(join, va), join.constant(u64, 0x3000000008n));
  // An indexed read through reg_save_area: integer slot `count` of the area.
  const slotOffset = join.int('shl', join.readRegister(integers[0]!), join.constant(u64, 3n));
  const word = join.load(u64, join.int('add', join.load(u64, at(join, va + 16n)), slotOffset));
  join.writeRegister(
    rax.register,
    variant === 'rsi_use' ? join.int('add', word, join.readRegister(integers[1]!)) : word,
  );
  join.return([join.readRegister(rax.register)]);
  const ir = constructSSA(b.finish(entry, [u64])).value as SSAForm;
  const types = recoverTypes(ir, abi, createOperationContext(), {
    image_id: image,
    slice_id: slice,
    revision: 0,
  });
  const extra = { types, source: { abi, callees: [], addresses: [] } };
  const structured = structureControlFlow(ir, createOperationContext());
  assert.ok(structured.value);
  return {
    ir,
    extra,
    view: (view: 'source' | 'checked') =>
      reconstruct({ function: structured.value!, ...extra }, createOperationContext(), view),
  };
}

test('sysv-amd64: the va_start lowering hides its stores and va_arg reads the save area through reg_save_area', () => {
  const fixture = sysvFixture('complete');
  const source = fixture.view('source');
  assert.ok(source.local_validation?.some((record) => record.rule === 'va_start'));
  assert.ok(
    source.local_validation_session?.abiConformance.some(
      (site) => site.rule === 'variadic_convention',
    ),
  );
  for (const language of ['c-like', 'python-like'] as const) {
    const output = emit(fixture.ir, fixture.extra, language).emission;
    assert.doesNotMatch(output.text, /\bentry_sp\b|uint128_t|unknown_value/, output.text);
    assert.match(output.text, /\.\.\.\)/, output.text);
    const formals = emittedFormals(output);
    assert.equal(formals.length, 1, output.text);
    // Slot 1 of the register save area holds the first anonymous integer argument.
    for (const word of words) {
      const memory = new Map<bigint, number>();
      for (let byte = 0n; byte < 176n; byte++) memory.set(0xa000n + byte, 0);
      writeWord(memory, 0xa008n, word);
      const observation = execute(
        output,
        new Map([
          [formals[0]!.statement_id, 1n],
          ['...', area],
          ['...registers', 0xa000n],
        ]),
        memory,
      );
      assert.deepEqual(observation.values, [word], `${language}`);
      // The footprint stores are va_start's own effect: only va_arg's reads remain.
      assert.deepEqual(observation.events, ['load', 'load'], `${language}`);
    }
  }
});

for (const variant of ['missing_xmm', 'rsi_use', 'call_between'] as const)
  test(`sysv-amd64: ${variant} leaves the footprint stores and the guard`, () => {
    const fixture = sysvFixture(variant);
    assert.ok(
      !fixture.view('source').local_validation?.some((record) => record.rule === 'va_start'),
    );
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(fixture.ir, fixture.extra, language).emission;
      // No `...` formal list (an open-arity call may print `f(...)`), no va_start.
      assert.doesNotMatch(output.text, /\w+, \.\.\.\)|va_start|\.va\b/, output.text);
      // The 128-bit vector saves still print.
      assert.match(output.text, /uint128_t/, output.text);
    }
  });

/** Darwin arm64 `uint64_t f(uint64_t count, ...)` summing `count` anonymous
 * words: every anonymous argument is on the stack, so `va_start` is the
 * entry SP itself and a pointer from it walks the caller's slots. */
function darwinFixture() {
  const abi = darwinArm64Abi;
  const x0 = location(abi, 0);
  const [cursor, total] = ['arm64:x9', 'arm64:x10'].map((root) =>
    abi.unknown_call_clobbers.registers.find(
      (register) => register.root === root && register.width_bits === 64,
    )!,
  ) as [RegisterDescriptor, RegisterDescriptor];
  const b = builder('darwin-variadic'),
    entry = b.block('entry'),
    loop = b.block('loop'),
    done = b.block('done');
  entry.writeRegister(cursor, entry.readRegister(abi.stack_pointer));
  entry.writeRegister(total, entry.constant(u64, 0n));
  entry.branch(
    entry.compare('eq', entry.readRegister(x0), entry.constant(u64, 0n)),
    entry.edge(done),
    entry.edge(loop),
  );
  const pointer = loop.readRegister(cursor);
  loop.writeRegister(total, loop.int('add', loop.readRegister(total), loop.load(u64, pointer)));
  loop.writeRegister(cursor, loop.int('add', pointer, loop.constant(u64, 8n)));
  const next = loop.int('sub', loop.readRegister(x0), loop.constant(u64, 1n));
  loop.writeRegister(x0, next);
  loop.branch(loop.compare('ne', next, loop.constant(u64, 0n)), loop.edge(loop), loop.edge(done));
  const sum = done.readRegister(total);
  done.writeRegister(x0, sum);
  done.return([sum]);
  return constructSSA(b.finish(entry, [u64])).value as SSAForm;
}

// S9: a DWARF-like `uint64_t f(uint64_t n, ...)` (or, contradicting the
// footprint, `f(uint64_t n, uint64_t m, ...)`) of the function itself.
const declaredVariadic = (
  ir: SSAForm,
  abi: AbiProfile,
  names: readonly string[],
  status?: 'hypothesis',
) => ({
  types: declaredTypes(ir, abi, {
    types: { u64: { kind: 'integer', bits: 64, signed: false } },
    returns: 'u64',
    parameters: names.map((name) => [name, 'u64'] as const),
    variadic: true,
    ...(status ? { status } : {}),
  }),
  source: { abi, callees: [], addresses: [] },
});

const variadicCases = [
  { abi: darwinArm64Abi, ir: () => darwinFixture() },
  { abi: windowsX64Abi, ir: () => win64Fixture('complete').ir },
  { abi: sysvAMD64Abi, ir: () => sysvFixture('complete').ir },
] as const;

for (const { abi, ir: build } of variadicCases) {
  test(`${abi.id}: a declared int f(n, ...) drives va_start and prints the declared prototype`, () => {
    const ir = build(),
      extra = declaredVariadic(ir, abi, ['n']);
    const sysv = abi.id === 'sysv-amd64';
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(ir, extra, language).emission;
      const text = output.text;
      assert.doesNotMatch(text, /\bentry_sp\b|\barg\d\b/, text);
      assert.match(
        text,
        language === 'c-like'
          ? /\(uint64_t n, \.\.\.\) \{/
          : /\(n: uint64_t, \.\.\.\) -> uint64_t:/,
        text,
      );
      assert.match(
        text,
        sysv
          ? /va_start\(frame\.va, n\)/
          : language === 'c-like'
            ? /va_start\(va, n\)/
            : /va = va_start\(n\)/,
        text,
      );
      for (const rule of ['declared_signature', 'va_start'])
        assert.ok(
          output.local_validation?.some((record) => record.rule === rule),
          rule,
        );
      const formals = emittedFormals(output);
      assert.deepEqual(
        formals.map((formal) => formal.name),
        ['n'],
      );
      for (let count = 1; count <= words.length; count++) {
        const memory = new Map<bigint, number>();
        let expected: bigint;
        if (sysv) {
          // The body reads integer slot n of the register save area.
          for (let byte = 0n; byte < 176n; byte++) memory.set(0xa000n + byte, 0);
          writeWord(memory, 0xa000n + 8n * BigInt(count % 6), words[count - 1]!);
          expected = words[count - 1]!;
        } else {
          words.forEach((word, index) => writeWord(memory, area + 8n * BigInt(index), word));
          expected = BigInt.asUintN(
            64,
            words.slice(0, count).reduce((sum, word) => sum + word, 0n),
          );
        }
        const observation = execute(
          output,
          new Map([
            [formals[0]!.statement_id, sysv ? BigInt(count % 6) : BigInt(count)],
            ['...', area],
            ['...registers', 0xa000n],
          ]),
          memory,
        );
        assert.deepEqual(observation.values, [expected], `${language} ${count}\n${text}`);
      }
    }
  });

  test(`${abi.id}: a declared ... naming more formals than the footprint keeps the inferred output`, () => {
    const ir = build();
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(ir, declaredVariadic(ir, abi, ['n', 'm']), language).emission;
      assert.equal(
        output.text,
        emit(ir, declaredVariadic(ir, abi, ['n', 'm'], 'hypothesis'), language).emission.text,
      );
      assert.doesNotMatch(output.text, /\bm\b/, output.text);
      assert.ok(!output.local_validation?.some((record) => record.rule === 'declared_signature'));
    }
  });
}
