import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext } from '../../../src/core/index.js';
import { integer } from '../../../src/ir/index.js';
import { nativeRegisterPrefix } from '../../../src/service/analysis/native-register-prefix.js';
import { builder, register } from '../../ir/support.js';

const pointer = register('arg0', 64, 0, 'replace_root', 'arg0');
const overwritten = register('arg1', 64, 0, 'replace_root', 'arg1');
const snapshotOnly = register('arg2', 64, 0, 'replace_root', 'arg2');

test('pre-SSA native prefix keeps real entry address reads, not rewritten or snapshot-only roots', () => {
  const ir = builder('native entry prefix'), entry = ir.block('entry');
  entry.load(integer(8), entry.readRegister(pointer));
  entry.writeRegister(overwritten, entry.constant(integer(64), 0x4000n));
  entry.load(integer(8), entry.readRegister(overwritten));
  entry.readRegister(snapshotOnly); // Physical return capacity is not a use.
  entry.return();
  const observed = nativeRegisterPrefix(ir.finish(entry), [pointer, overwritten, snapshotOnly], createOperationContext());
  assert.deepEqual(observed.parameters.map((parameter) => parameter.root), ['arg0']);
  assert.deepEqual(observed.returns, []);
  assert.equal(observed.argument_list_complete, false);
  assert.equal(observed.parameter_state, 'ambiguous');
});

test('pre-SSA native prefix does not guess state on later CFG blocks', () => {
  const ir = builder('native later block'), entry = ir.block('entry'), next = ir.block('next');
  entry.load(integer(8), entry.readRegister(pointer));
  entry.jump(next);
  next.load(integer(8), next.readRegister(overwritten));
  next.return();
  const observed = nativeRegisterPrefix(ir.finish(entry), [pointer, overwritten], createOperationContext());
  assert.deepEqual(observed.parameters.map((parameter) => parameter.root), ['arg0']);
  assert.equal(observed.argument_list_complete, false, 'An unobserved later requirement is not a zero-argument proof');
});
