import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext } from '../../../src/core/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { analyzeCalls } from '../../../src/analysis/calls/index.js';
import { observeIndirectCallInterfaces } from '../../../src/analysis/calls/observed.js';
import { integer } from '../../../src/ir/index.js';
import { builder, register } from '../../ir/support.js';

for (const preparation of ['forwarded', 'unchanged', 'scratch', 'second-slot-only'] as const)
  test(`callback ${preparation}: argument preparation is not mere register liveness or complete arity`, () => {
    const ir = builder(`observed-callback-${preparation}`), block = ir.block('entry');
    const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
    const edi = register('edi', 32, 0, 'zero_extend_root', 'x86_64:rdi');
    const esi = register('esi', 32, 0, 'zero_extend_root', 'x86_64:rsi');
    const eax = register('eax', 32, 0, 'zero_extend_root', 'x86_64:rax');
    const target = block.readRegister(rdi), argument = block.readRegister(esi);
    if (preparation === 'forwarded') block.writeRegister(edi, argument);
    else if (preparation === 'scratch')
      block.writeRegister(register('r10d', 32, 0, 'zero_extend_root', 'x86_64:r10'), argument);
    else if (preparation === 'second-slot-only')
      block.writeRegister(esi, block.extract(target, 0, 32));
    block.call({ kind: 'indirect', value: target }, [], [], sysvAMD64Abi.unknown_call_clobbers);
    const result = block.int('add', block.readRegister(eax), block.constant(integer(32), 1n));
    block.return([result]);
    const ssa = constructSSA(ir.finish(block, [integer(32)])).value;
    assert.ok(ssa.form === 'ssa');
    const context = createOperationContext();
    const analysis = analyzeCalls(ssa, sysvAMD64Abi, context);
    const observed = observeIndirectCallInterfaces(ssa, sysvAMD64Abi, analysis, context);
    assert.equal(observed.length, 1);
    assert.equal(observed[0]!.argument_list_complete, false);
    assert.deepEqual(observed[0]!.parameters.map((parameter) => [parameter.root, parameter.width_bits]),
      preparation === 'forwarded' ? [['x86_64:rdi', 32]] : []);
    assert.deepEqual(observed[0]!.returns.map((returned) => [returned.root, returned.width_bits]),
      [['x86_64:rax', 32]]);
  });
