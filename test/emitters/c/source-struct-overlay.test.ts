import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { recoverTypes, type TypeRecoveryResult } from '../../../src/analysis/types/index.js';
import { createOperationContext } from '../../../src/core/index.js';
import { integer, type DataType, type SSAForm, type Value } from '../../../src/ir/index.js';
import { builder, image, register, slice } from '../../ir/support.js';
import { emit, emittedFormals, execute } from './support.js';

const i64 = integer(64);

interface Overlay {
  readonly ssa: SSAForm;
  readonly types: TypeRecoveryResult;
}

/** `q[0] = p->at16 (integer word); p->at16 = -p->at16 (IEEE binary32/64)`. The
 * two accesses of the same bytes are distinct loads; the second is only ever
 * reinterpreted as a float. `width` selects the integer word's width. */
function overlay(name: string, bits: 32 | 64 = 64, width: number = bits): Overlay {
  const b = builder(name),
    block = b.block('entry');
  const p = block.readRegister(register('rdi', 64, 0, 'replace_root', 'x86_64:rdi'));
  const q = block.readRegister(register('rsi', 64, 0, 'replace_root', 'x86_64:rsi'));
  const fp: DataType = { kind: 'float', bits };
  const field = (): Value => block.int('add', p, block.constant(i64, 16n));
  block.store(q, block.load(integer(width), field()));
  const word = block.load(integer(bits), field());
  const negated = block.assign(fp, {
    kind: 'float_unary',
    op: 'neg',
    value: block.cast('bitcast', fp, word),
  });
  block.store(field(), block.cast('bitcast', integer(bits), negated));
  block.return([]);
  const ssa = constructSSA(b.finish(block, [])).value as SSAForm;
  const types = recoverTypes(ssa, sysvAMD64Abi, createOperationContext(), {
    slice_id: slice,
    image_id: image,
    revision: 1,
  });
  return { ssa, types };
}

const source = { abi: sysvAMD64Abi, callees: [], addresses: [] };
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
const compileC = (text: string): void => {
  const compiled = spawnSync(
    'clang',
    ['-x', 'c', '-fsyntax-only', '-std=c11', '-include', 'stdint.h', '-include', 'stddef.h', '-'],
    { input: text, encoding: 'utf8' },
  );
  assert.equal(compiled.status, 0, compiled.stderr);
};

test('integer and double accesses of one offset are two non-conflicting fields of one shape', () => {
  const { types } = overlay('overlay-shape');
  assert.deepEqual(
    types.conflicts.filter((conflict) => conflict.reason === 'overlapping_accesses'),
    [],
  );
  const shape = types.shapes.find((item) => item.fields.some((field) => field.offset === 16n))!;
  assert.deepEqual(
    shape.fields.map((field) => [field.offset, field.width_bits, field.float === true]),
    [
      [16n, 64, false],
      [16n, 64, true],
    ],
  );
  const members = types.types.find((record) => record.id === shape.type_id)?.definition;
  assert.equal(members?.kind, 'structure');
  if (members?.kind !== 'structure') return;
  assert.deepEqual(
    members.fields.map((field) => [field.offset, field.name]),
    [
      [16n, 'field_10'],
      [16n, 'field_10_f'],
    ],
  );
  const kinds = members.fields.map(
    (field) => types.types.find((record) => record.id === field.type_id)?.definition,
  );
  assert.deepEqual(
    kinds.map((kind) => kind?.kind),
    ['integer', 'float'],
  );
});

for (const bits of [32, 64] as const) {
  const element = bits === 32 ? 'float' : 'double',
    unsigned = `uint${bits}_t`;
  test(`c-like prints the ${element} overlay as an anonymous union and each access uses its own member`, () => {
    const { ssa, types } = overlay(`overlay-c-${bits}`, bits);
    const { emission } = emit(ssa, { types, source });
    assert.match(
      emission.text,
      new RegExp(
        `struct \\w+ \\{[^}]*union \\{ ${unsigned} field_0x10; ${element} field_0x10_f; \\};[^}]*\\};`,
      ),
      emission.text,
    );
    assert.match(emission.text, /->field_0x10_f\b/);
    assert.match(emission.text, /= \w+->field_0x10;/);
    assert.doesNotMatch(
      emission.text,
      /\((?:double|float|uint\d+_t) \*\)|__od_bitcast|cast_bitcast/,
    );
    const rules = emission.local_validation?.map((record) => record.rule) ?? [];
    assert.ok(rules.includes('struct_member_overlay'));
    assert.ok(
      emission.requirements?.some((item) => item.explanation.includes('anonymous union')),
      'the union reinterpretation is a published requirement',
    );
    compileC(emission.text);
  });

  const sign = 1n << BigInt(bits - 1);
  const patterns: readonly [string, bigint][] = [
    ['positive zero', 0n],
    ['negative zero', sign],
    ['signaling NaN payload', bits === 32 ? 0x7fa12345n : 0x7ff0123456789abcn],
    ['negative NaN payload', sign | (bits === 32 ? 0x7fc00001n : 0x7ff8000000000001n)],
    ['all ones', (1n << BigInt(bits)) - 1n],
    ['one', bits === 32 ? 0x3f800000n : 0x3ff0000000000000n],
  ];
  for (const language of ['c-like', 'python-like'] as const)
    test(`${language} ${element} overlay executes with every bit pattern preserved`, () => {
      const { ssa, types } = overlay(`overlay-run-${language}-${bits}`, bits);
      const { emission } = emit(ssa, { types, source }, language);
      if (language === 'python-like')
        assert.match(emission.text, new RegExp(`memory\\.f${bits}\\[`));
      const [p, q] = emittedFormals(emission);
      for (const [name, value] of patterns) {
        const memory = new Map([
          ...bytes(0x2010n, value, bits / 8),
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
        // The integer member read the original bits; the float member wrote them negated.
        assert.equal(word(observed.memory, 0x3000n, bits / 8), value, `${name}: integer member`);
        assert.equal(
          word(observed.memory, 0x2010n, bits / 8),
          value ^ sign,
          `${name}: float member`,
        );
        assert.deepEqual(observed.events, ['load', 'store', 'load', 'store']);
      }
    });
}

test('a different-width view of the same bytes is still an overlapping-access conflict', () => {
  const { ssa, types } = overlay('overlay-width', 64, 32);
  const conflicts = types.conflicts.filter(
    (conflict) => conflict.reason === 'overlapping_accesses',
  );
  assert.ok(conflicts.length > 0);
  const { emission } = emit(ssa, { types, source });
  // The losing access keeps its explicit cast; no union overlays unequal widths.
  assert.doesNotMatch(emission.text, /\bunion\b/);
  assert.match(emission.text, /\(uint32_t \*\)/);
  compileC(emission.text);
});
