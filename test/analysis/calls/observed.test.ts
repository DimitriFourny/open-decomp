import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext } from '../../../src/core/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { analyzeCalls } from '../../../src/analysis/calls/index.js';
import { observePreparedCallInterfaces } from '../../../src/analysis/calls/observed.js';
import { recoverTypes } from '../../../src/analysis/types/index.js';
import { integer } from '../../../src/ir/index.js';
import { builder, image, register, slice } from '../../ir/support.js';
import { emit, emittedFormals, execute, type SourceCallOracle } from '../../emitters/c/support.js';

for (const preparation of ['forwarded', 'preserved-low16', 'unchanged', 'scratch', 'second-slot-only'] as const)
  test(`callback ${preparation}: argument preparation is not mere register liveness or complete arity`, () => {
    const ir = builder(`observed-callback-${preparation}`), block = ir.block('entry');
    const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
    const edi = register('edi', 32, 0, 'zero_extend_root', 'x86_64:rdi');
    const esi = register('esi', 32, 0, 'zero_extend_root', 'x86_64:rsi');
    const eax = register('eax', 32, 0, 'zero_extend_root', 'x86_64:rax');
    const target = block.readRegister(rdi), argument = block.readRegister(esi);
    if (preparation === 'forwarded') block.writeRegister(edi, argument);
    else if (preparation === 'preserved-low16')
      block.writeRegister(register('di', 16, 0, 'preserve_other_bits', rdi.root), block.constant(integer(16), 0x1234n));
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
    const observed = observePreparedCallInterfaces(ssa, sysvAMD64Abi, analysis, context);
    assert.equal(observed.length, 1);
    assert.equal(observed[0]!.argument_list_complete, false);
    const hasArgument = preparation === 'forwarded' || preparation === 'preserved-low16';
    assert.deepEqual(observed[0]!.parameters.map((parameter) => parameter.root),
      hasArgument ? ['x86_64:rdi'] : []);
    assert.deepEqual(observed[0]!.returns.map((returned) => [returned.root, returned.width_bits]),
      [['x86_64:rax', 32]]);
    const types = recoverTypes(ssa, sysvAMD64Abi, context, { image_id: image, slice_id: slice, revision: 0 });
    const targetBits = 0x123456786000n; // Canonical user pointer with nonzero high32.
    for (const language of ['c-like', 'python-like'] as const) {
      const { emission } = emit(ssa, { types,
        source: { abi: sysvAMD64Abi, callees: observed, addresses: [] } }, language);
      for (const incoming of [0xa5a5a5a512345678n, 0xffffffffffffffffn]) {
        const formals = emittedFormals(emission);
        assert.equal(formals.length, preparation === 'forwarded' ? 2 : 1);
        const inputs = new Map(formals.map((formal, index) => [formal.statement_id,
          index === 0 ? targetBits : BigInt.asUintN(32, incoming)]));
        const calls = new Map<string, SourceCallOracle>();
        const argument = preparation === 'preserved-low16'
          ? (targetBits & ~0xffffn) | 0x1234n : BigInt.asUintN(32, incoming);
        calls.set(`0x${targetBits.toString(16)}`, (args, call) => {
          assert.equal(call.arguments_complete, false, 'An observed prefix never closes unknown arity');
          assert.deepEqual(args, hasArgument ? [argument] : []);
          // Explicit test environment: prepared callbacks use their whole
          // physical input; counterexamples ignore unresolved input lists.
          return hasArgument ? BigInt.asUintN(32, argument + 3n) : 37n;
        });
        const result = execute(emission, inputs, new Map(), 0n, new Map(),
          new Map([['non-argument entry register', 0n]]), calls);
        assert.equal(result.exit, 'machine_return', `${language}: ${preparation}`);
        assert.deepEqual(result.values, [hasArgument ? BigInt.asUintN(32, argument + 4n) : 38n]);
        assert.deepEqual(result.calls, [{ target: targetBits,
          arguments: hasArgument ? [argument] : [], arguments_complete: false }]);
      }
    }
  });

test('a prepared low16 slot does not fabricate unknown upper carrier bits', () => {
  const ir = builder('callback-unknown-upper-carrier'), block = ir.block('entry');
  const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
  const di = register('di', 16, 0, 'preserve_other_bits', rdi.root);
  const eax = register('eax', 32, 0, 'zero_extend_root', 'x86_64:rax');
  const target = block.readRegister(rdi);
  block.writeRegister(rdi, block.indeterminate(integer(64), 'unknown', 'unsupported upper input'));
  block.writeRegister(di, block.constant(integer(16), 0x1234n));
  block.call({ kind: 'indirect', value: target }, [], [], sysvAMD64Abi.unknown_call_clobbers);
  block.return([block.readRegister(eax)]);
  const ssa = constructSSA(ir.finish(block, [integer(32)])).value;
  assert.equal(ssa.form, 'ssa');
  if (ssa.form !== 'ssa') throw new Error('Expected SSA');
  const context = createOperationContext();
  const observed = observePreparedCallInterfaces(ssa, sysvAMD64Abi, analyzeCalls(ssa, sysvAMD64Abi, context), context);
  const types = recoverTypes(ssa, sysvAMD64Abi, context, { image_id: image, slice_id: slice, revision: 0 });
  for (const language of ['c-like', 'python-like'] as const) {
    const { emission } = emit(ssa, { types, source: { abi: sysvAMD64Abi, callees: observed, addresses: [] } }, language);
    const formals = emittedFormals(emission);
    assert.equal(formals.length, 1);
    let invoked = false;
    const calls = new Map<string, SourceCallOracle>([['0x6000', () => { invoked = true; return 37n; }]]);
    const result = execute(emission, new Map([[formals[0]!.statement_id, 0x6000n]]),
      new Map(), 0n, new Map(), new Map([['non-argument entry register', 0n]]), calls);
    assert.equal(result.exit, 'unknown', 'The unresolved same-argument bits are not trailing argument arity');
    assert.equal(invoked, false, 'No concrete call may receive invented zero upper bits');
  }
});
