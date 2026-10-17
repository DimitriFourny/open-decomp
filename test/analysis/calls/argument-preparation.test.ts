import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext } from '../../../src/core/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { analyzeCalls } from '../../../src/analysis/calls/index.js';
import { observePreparedCallInterfaces } from '../../../src/analysis/calls/observed.js';
import { integer } from '../../../src/ir/index.js';
import { builder, image, register } from '../../ir/support.js';

const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
const rsi = register('rsi', 64, 0, 'replace_root', 'x86_64:rsi');
const rdx = register('rdx', 64, 0, 'replace_root', 'x86_64:rdx');
const eax = register('eax', 32, 0, 'zero_extend_root', 'x86_64:rax');
for (const targetKind of ['direct', 'indirect'] as const)
  for (const preparation of ['load', 'constant', 'computation', 'forwarded', 'unchanged', 'unknown', 'target', 'target-copy'] as const)
    test(`${targetKind} ${preparation}: authored prefix evidence does not establish complete arity`, () => {
      const ir = builder(`prepared-${targetKind}-${preparation}`), block = ir.block('entry');
      const target = block.readRegister(rdx), incoming = block.readRegister(rdi);
      const forwarded = block.readRegister(rsi);
      const value = preparation === 'load' ? block.load(integer(64), incoming)
        : preparation === 'constant' ? block.constant(integer(64), 21n)
        : preparation === 'computation' ? block.int('add', incoming, block.constant(integer(64), 6n))
        : preparation === 'forwarded' ? forwarded
        : preparation === 'unknown' ? block.indeterminate(integer(64), 'unknown', 'unresolved caller value')
        : preparation === 'target' ? target
        : preparation === 'target-copy' ? block.cast('bitcast', integer(64), target) : incoming;
      if (preparation !== 'unchanged') block.writeRegister(rdi, value);
      block.call(targetKind === 'direct'
        ? { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } }
        : { kind: 'indirect', value: target }, [], [], sysvAMD64Abi.unknown_call_clobbers);
      block.return([block.readRegister(eax)]);
      const ssa = constructSSA(ir.finish(block, [integer(32)])).value;
      assert.equal(ssa.form, 'ssa');
      if (ssa.form !== 'ssa') throw new Error('Expected SSA');
      const context = createOperationContext();
      const observed = observePreparedCallInterfaces(ssa, sysvAMD64Abi, analyzeCalls(ssa, sysvAMD64Abi, context), context);
      assert.equal(observed.length, 1);
      const accepted = ['load', 'constant', 'computation', 'forwarded'].includes(preparation) ||
        targetKind === 'direct' && ['target', 'target-copy'].includes(preparation);
      assert.deepEqual(observed[0]!.parameters.map((parameter) => parameter.root), accepted ? ['x86_64:rdi'] : []);
      assert.equal(observed[0]!.argument_list_complete, false);
      assert.deepEqual(observed[0]!.returns.map((result) => [result.root, result.width_bits]), [['x86_64:rax', 32]]);
    });

for (const allPaths of [false, true])
  test(`joined caller preparation requires every incoming path (${allPaths})`, () => {
    const ir = builder(`prepared-join-${allPaths}`), entry = ir.block('entry', [integer(1)]);
    const yes = ir.block('yes', [integer(64), integer(64)]);
    const no = ir.block('no', [integer(64), integer(64)]), end = ir.block('end', [integer(64)]);
    const target = entry.readRegister(rdx), pointer = entry.readRegister(rdi);
    entry.branch(entry.parameters[0]!, entry.edge(yes, [target, pointer]), entry.edge(no, [target, pointer]));
    yes.writeRegister(rdi, yes.load(integer(64), yes.parameters[1]!));
    if (allPaths) no.writeRegister(rdi, no.constant(integer(64), 37n));
    yes.jump(end, [yes.parameters[0]!]);
    no.jump(end, [no.parameters[0]!]);
    end.call({ kind: 'indirect', value: end.parameters[0]! }, [], [], sysvAMD64Abi.unknown_call_clobbers);
    end.return([end.readRegister(eax)]);
    const ssa = constructSSA(ir.finish(entry, [integer(32)])).value;
    assert.equal(ssa.form, 'ssa');
    if (ssa.form !== 'ssa') throw new Error('Expected SSA');
    const context = createOperationContext();
    const observed = observePreparedCallInterfaces(ssa, sysvAMD64Abi, analyzeCalls(ssa, sysvAMD64Abi, context), context);
    assert.deepEqual(observed[0]!.parameters.map((parameter) => parameter.root), allPaths ? ['x86_64:rdi'] : []);
    assert.equal(observed[0]!.argument_list_complete, false);
  });
