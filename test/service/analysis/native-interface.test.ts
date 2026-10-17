import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext } from '../../../src/core/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { floating, integer, vector } from '../../../src/ir/index.js';
import { createNativeInterfaceIndex, nativeEntryRegisters } from '../../../src/service/analysis/native-entry.js';
import { nativeReturnInterface, nativeTypeSlices } from '../../../src/service/analysis/native-transfer.js';
import type { NativeInterface } from '../../../src/service/analysis/native-worklist.js';
import { builder, image, register } from '../../ir/support.js';

const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
const rsi = register('rsi', 64, 0, 'replace_root', 'x86_64:rsi');
const rdx = register('rdx', 64, 0, 'replace_root', 'x86_64:rdx');
const rax = register('rax', 64, 0, 'replace_root', 'x86_64:rax');
const xmm0 = { ...register('xmm0', 128, 0, 'replace_root', 'x86_64:xmm0', 128), bank: 'vector' as const };

test('prepared native interfaces re-evaluate changing callee input, write and FP carrier contracts', () => {
  const input = builder('native changing interfaces'), block = input.block('entry');
  block.readRegister(rdi);
  block.readRegister(rsi);
  block.call({ kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } }, [], [],
    { registers: [rax, xmm0], flags: [], memory: 'unknown_read_write' });
  block.readRegister(rax);
  block.readRegister(xmm0);
  block.return();
  const ir = constructSSA(input.finish(block)).value;
  if (ir.form !== 'ssa') throw new TypeError('Expected SSA');
  const call = ir.blocks[0]!.instructions.find((node) => node.kind === 'call')!;
  const context = createOperationContext(), index = createNativeInterfaceIndex(ir, sysvAMD64Abi, context);
  const interfaces = new Map<string, NativeInterface>();
  const inputs = () => nativeEntryRegisters(ir, [rdi, rsi], interfaces, [], context, index).map((item) => item.root);
  const returns = () => nativeReturnInterface(ir, sysvAMD64Abi, null, interfaces, context, false, [], false, index);
  assert.deepEqual(inputs(), []);
  assert.deepEqual(returns().returns, []);
  const low = { ...rax, width_bits: 32 };
  interfaces.set(call.id, { parameters: [rdi], returns: [low], return_types: [integer(32)],
    written_result: { registers: [low], types: [integer(32)] },
    parameter_state: 'observed', argument_list_complete: false });
  assert.deepEqual(inputs(), [rdi.root]);
  assert.deepEqual(returns().returns.map((item) => [item.root, item.width_bits]), [[rax.root, 32]]);
  interfaces.set(call.id, { parameters: [rsi], returns: [rax], return_types: [integer(64)],
    written_result: { registers: [rax], types: [integer(64)] },
    parameter_state: 'observed', argument_list_complete: false });
  assert.deepEqual(inputs(), [rsi.root]);
  assert.deepEqual(returns().returns.map((item) => [item.root, item.width_bits]), [[rax.root, 64]]);
  for (const type of [floating(64), vector(integer(32), 4)]) {
    interfaces.set(call.id, { parameters: [], returns: [xmm0], return_types: [type],
      parameter_state: 'observed', argument_list_complete: false });
    const slices = nativeTypeSlices(ir, interfaces, context, index);
    assert.ok(slices.length > 0);
    assert.ok(slices.every(([, slice]) => slice.written && slice.type === type));
  }
  interfaces.clear();
  assert.deepEqual(inputs(), []);
  assert.deepEqual(returns().returns, []);
  assert.deepEqual(nativeTypeSlices(ir, interfaces, context, index), []);
  assert.throws(() => nativeEntryRegisters({ ...ir }, [rdi], interfaces, [], context, index), TypeError);
  assert.throws(() => nativeReturnInterface(ir, {
    ...sysvAMD64Abi, classifyCall: sysvAMD64Abi.classifyCall.bind(sysvAMD64Abi),
  }, null, interfaces, context, false, [], false, index), TypeError);
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => nativeEntryRegisters(ir, [rdi], interfaces, [],
    createOperationContext({ signal: controller.signal }), index), { code: 'cancelled' });
});

test('prepared store ancestry excludes private spills but retains externally stored payloads', () => {
  const input = builder('native store ancestry'), block = input.block('entry');
  const sp = { ...register('rsp', 64, 0, 'replace_root', 'x86_64:rsp'), role: 'stack_pointer' as const };
  block.store(block.int('add', block.readRegister(sp), block.constant(integer(64), 8n)), block.readRegister(rsi));
  block.store(block.readRegister(rdi), block.readRegister(rdx));
  block.return();
  const ir = constructSSA(input.finish(block)).value;
  if (ir.form !== 'ssa') throw new TypeError('Expected SSA');
  const context = createOperationContext(), index = createNativeInterfaceIndex(ir, sysvAMD64Abi, context);
  assert.deepEqual(nativeEntryRegisters(ir, [rdi, rsi, rdx], new Map(), [], context, index)
    .map((item) => item.root), [rdi.root, rdx.root]);
});

test('secondary aggregate return storage remains demand-specific on the same prepared stage', () => {
  const input = builder('native secondary demand'), block = input.block('entry');
  block.writeRegister(rax, block.constant(integer(64), 3n));
  block.writeRegister(rdx, block.constant(integer(64), 7n));
  block.return();
  const ir = constructSSA(input.finish(block)).value;
  if (ir.form !== 'ssa') throw new TypeError('Expected SSA');
  const context = createOperationContext(), index = createNativeInterfaceIndex(ir, sysvAMD64Abi, context);
  const query = (demand: readonly typeof rax[]) => nativeReturnInterface(ir, sysvAMD64Abi, null,
    new Map(), context, false, demand, false, index).returns.map((item) => [item.root, item.width_bits]);
  assert.deepEqual(query([]), [[rax.root, 64]]);
  assert.deepEqual(query([rdx]), [[rax.root, 64], [rdx.root, 64]]);
  assert.deepEqual(query([]), [[rax.root, 64]]);
});
