import assert from 'node:assert/strict';
import test from 'node:test';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { integer, type DataType, type SSAForm } from '../../../src/ir/index.js';
import { builder, image, register } from '../../ir/support.js';
import { emit, emittedFormals, execute } from './support.js';

const i64 = integer(64),
  f64: DataType = { kind: 'float', bits: 64 };
const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
const xmm0 = { ...register('xmm0', 64, 0, 'replace_root', 'x86_64:zmm0'), bank: 'vector' as const };
const source = { abi: sysvAMD64Abi, callees: [], addresses: [] };
const writing = { registers: [], flags: [], memory: 'unknown_read_write' as const };
const target = (value: bigint) => ({
  kind: 'direct' as const,
  address: { image_id: image, space: 'va' as const, value },
});
type Shape = 'plain' | 'store' | 'twice' | 'load' | 'nested' | 'jump' | 'pure_between';
function shaped(shape: Shape) {
  const b = builder(`call-inlining-${shape}`),
    entry = b.block('entry');
  const pointer = entry.readRegister(rdi);
  const [first] = entry.call(target(0x4000n), [pointer], [i64], writing);
  let result = first!;
  if (shape === 'nested') result = entry.call(target(0x5000n), [result], [i64], writing)[0]!;
  if (shape === 'store') entry.store(entry.constant(i64, 0x3000n), entry.constant(integer(8), 7n));
  if (shape === 'pure_between') entry.int('add', pointer, entry.constant(i64, 8n));
  if (shape === 'twice') result = entry.int('add', result, result);
  if (shape === 'load') result = entry.int('add', result, entry.load(i64, pointer));
  if (shape === 'jump') {
    const next = b.block('next');
    entry.jump(next);
    next.return([result]);
  } else entry.return([result]);
  return constructSSA(b.finish(entry, [i64])).value as SSAForm;
}

for (const language of ['c-like', 'python-like'] as const) {
  const render = (shape: Shape) => emit(shaped(shape), { source }, language).emission;
  const inlined = /return sub_\w+\(/;

  test(`${language} a single-use call result read by the return prints as that return's operand`, () => {
    for (const shape of ['plain', 'pure_between', 'jump'] as const) {
      const output = render(shape);
      assert.match(output.text, inlined, `${shape}\n${output.text}`);
      assert.doesNotMatch(output.text, /call_result/, shape);
      assert.ok(
        output.local_validation?.some((record) => record.rule === 'single_use_call_inlining'),
      );
      assert.doesNotMatch(
        emit(shaped(shape), { source }, language, 'checked').emission.text,
        /return sub_\w+\(/,
      );
    }
  });

  test(`${language} chained single-use calls nest in their original order`, () => {
    const output = render('nested');
    assert.match(output.text, /return sub_\w+\(sub_\w+\(/, output.text);
    assert.doesNotMatch(output.text, /call_result/);
  });

  test(`${language} an intervening effect, a second use or an unsequenced load keeps the call a statement`, () => {
    for (const shape of ['store', 'twice', 'load'] as const) {
      const output = render(shape);
      assert.match(output.text, /call_result/, `${shape}\n${output.text}`);
      assert.doesNotMatch(output.text, inlined, shape);
      assert.ok(
        !output.local_validation?.some((record) => record.rule === 'single_use_call_inlining'),
        shape,
      );
    }
  });
}

/** `input` is a double formal, copied through an integer bit pattern and back; the copy is read twice. */
function copied(reinterpret: boolean) {
  const b = builder(`fp-copy-${reinterpret}`),
    entry = b.block('entry');
  const formal = entry.readRegister(xmm0, f64);
  const bits = entry.cast('bitcast', i64, formal);
  const copy = entry.cast('bitcast', f64, bits);
  const sum = entry.assign(f64, { kind: 'float', op: 'add', left: copy, right: copy });
  entry.return([reinterpret ? entry.int('add', entry.cast('bitcast', i64, copy), bits) : sum]);
  return constructSSA(b.finish(entry, [reinterpret ? i64 : f64])).value as SSAForm;
}

for (const language of ['c-like', 'python-like'] as const)
  test(`${language} a repeated copy of an FP formal reads the formal; an integer reinterpretation stays a conversion`, () => {
    const plain = emit(copied(false), { source }, language).emission;
    const formal = emittedFormals(plain)[0]!;
    assert.doesNotMatch(plain.text, /\bvalue\d+ = arg0\b|\bvalue\d+ = \w*arg0\b/, plain.text);
    assert.ok(plain.local_validation?.some((record) => record.rule === 'copy_propagation'));
    const observed = execute(
      plain,
      new Map(formal.semantic_ids.map((id) => [id, 0x3ff0000000000000n])),
    );
    assert.deepEqual(observed.values, [0x4000000000000000n]);
    const reinterpreted = emit(copied(true), { source }, language).emission;
    assert.match(reinterpreted.text, /bitcast|bits/, reinterpreted.text);
  });
