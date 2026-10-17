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

test('an unresolved callback result does not invent zero upper bits consumed by its caller', () => {
  const ir = builder('callback-arbitrary-upper-result'),
    block = ir.block('entry');
  const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
  const rax = register('rax', 64, 0, 'replace_root', 'x86_64:rax');
  const target = block.readRegister(rdi);
  block.call({ kind: 'indirect', value: target }, [], [], sysvAMD64Abi.unknown_call_clobbers);
  block.return([block.int('add', block.readRegister(rax), block.constant(integer(64), 1n))]);
  const ssa = constructSSA(ir.finish(block, [integer(64)])).value;
  assert.equal(ssa.form, 'ssa');
  if (ssa.form !== 'ssa') throw new Error('Expected SSA');
  const context = createOperationContext();
  const observed = observePreparedCallInterfaces(
    ssa,
    sysvAMD64Abi,
    analyzeCalls(ssa, sysvAMD64Abi, context),
    context,
  );
  const types = recoverTypes(ssa, sysvAMD64Abi, context, {
    image_id: image,
    slice_id: slice,
    revision: 0,
  });
  const targetBits = 0x6000n;
  for (const language of ['c-like', 'python-like'] as const) {
    const { emission } = emit(
      ssa,
      { types, source: { abi: sysvAMD64Abi, callees: observed, addresses: [] } },
      language,
    );
    const formals = emittedFormals(emission);
    assert.equal(formals.length, 1);
    // The callee has no established upper-bit contract. Two explicit physical
    // environments share low32=37 and disagree above it; neither becomes zero.
    for (const returned of [0x1234567800000025n, 0xfedcba9800000025n]) {
      const calls = new Map<string, SourceCallOracle>();
      calls.set(`0x${targetBits.toString(16)}`, (args, call) => {
        assert.deepEqual(args, []);
        assert.equal(call.arguments_complete, false);
        // This particular oracle ignores the unresolved input list; that is not
        // an inferred zero-argument signature for the production callback.
        return returned;
      });
      const result = execute(
        emission,
        new Map([[formals[0]!.statement_id, targetBits]]),
        new Map(),
        0n,
        new Map(),
        new Map([['non-argument entry register', 0n]]),
        calls,
      );
      assert.equal(result.exit, 'machine_return');
      assert.deepEqual(
        result.values.map((value) => BigInt.asUintN(64, value)),
        [BigInt.asUintN(64, returned + 1n)],
      );
      assert.deepEqual(result.calls, [
        { target: targetBits, arguments: [], arguments_complete: false },
      ]);
    }
  }
});
