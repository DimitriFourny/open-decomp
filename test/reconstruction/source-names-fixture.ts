import assert from 'node:assert/strict';
import { createOperationContext } from '../../src/core/index.js';
import { sysvAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../src/analysis/types/index.js';
import { integer, type SSAForm } from '../../src/ir/index.js';
import { builder, image, register, slice } from '../ir/support.js';
import { emit, emittedFormals, execute, type SourceCallOracle } from '../emitters/c/support.js';

/** Source-role counterexample: one unchanged target is both observed data storage
 * and a called address. Neither role uniquely describes it. No target executes;
 * the independent trusted callback oracle observes its argument and returns 42. */
export function checkSourceNameConflicts(): void {
  const b = builder('source-name-conflict'),
    entry = b.block('entry'),
    u64 = integer(64);
  const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
  const rsi = register('rsi', 64, 0, 'replace_root', 'x86_64:rsi');
  const target = entry.readRegister(rdi),
    value = entry.readRegister(rsi);
  entry.load(u64, target);
  const returned = entry.call(
    { kind: 'indirect', value: target },
    [value],
    [u64],
    sysvAMD64Abi.unknown_call_clobbers,
  )[0]!;
  entry.return([returned]);
  const constructed = constructSSA(b.finish(entry, [u64]));
  assert.equal(constructed.value.form, 'ssa');
  const ir = constructed.value as SSAForm;
  const types = recoverTypes(ir, sysvAMD64Abi, createOperationContext(), {
    image_id: image,
    slice_id: slice,
    revision: 0,
  });
  const physical = ir.register_states.find((state) => state.block === ir.entry)!.entry;
  const targetInput = physical.find((binding) => binding.register.root === rdi.root)!.value.id;
  for (const language of ['c-like', 'python-like'] as const)
    for (const supplied of [
      [],
      [{ entity_id: targetInput, name: 'provided_target' }],
      [
        { entity_id: targetInput, name: 'one_name' },
        { entity_id: targetInput, name: 'another_name' },
      ],
    ]) {
      const output = emit(
        ir,
        { types, source: { abi: sysvAMD64Abi, callees: [], addresses: [] }, names: supplied },
        language,
      );
      const formals = emittedFormals(output.emission);
      assert.equal(formals.length, 2);
      assert.ok(
        formals[0]!.semantic_ids.includes(targetInput),
        'original annotation subject remains navigable',
      );
      if (supplied.length === 1) assert.equal(formals[0]!.name, 'provided_target');
      else
        assert.match(
          formals[0]!.name,
          /^arg\d+$/,
          'conflicting roles or display names stay neutral',
        );
      const memory = new Map<bigint, number>();
      for (let index = 0; index < 8; index++) memory.set(0x6000n + BigInt(index), 0xa5);
      const oracle: SourceCallOracle = (values) => {
        assert.deepEqual(values, [35n]);
        return 42n;
      };
      const observation = execute(
        output.emission,
        new Map([
          [formals[0]!.statement_id, 0x6000n],
          [formals[1]!.statement_id, 35n],
        ]),
        memory,
        0n,
        new Map(),
        new Map(),
        new Map([['0x6000', oracle]]),
      );
      assert.deepEqual(observation.values, [42n]);
      assert.deepEqual(observation.events, ['load', 'call']);
    }
}
