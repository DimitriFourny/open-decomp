import assert from 'node:assert/strict';
import test from 'node:test';
import { ConstantOffsets, Decoder, Formatter, Instruction, InstructionInfo, InstructionInfoFactory, OpCodeInfo, UsedMemory, UsedRegister } from 'iced-x86';
import { createOperationContext, OperationError } from '../../../src/core/index.js';
import { X86Decoder } from '../../../src/decoders/x86_64/index.js';
import { imageFromBytes, region } from './helpers.js';

test('repeated decode frees every WASM result wrapper and reuses one instruction per request', (t) => {
  const freed: Record<string, number> = {};
  for (const native of [ConstantOffsets, Decoder, Formatter, Instruction, InstructionInfo, InstructionInfoFactory, OpCodeInfo, UsedMemory, UsedRegister]) {
    const original = native.prototype.free;
    t.mock.method(native.prototype, 'free', function (this: { free(): void }) {
      freed[native.name] = (freed[native.name] ?? 0) + 1;
      original.call(this);
    });
  }
  let usedRegisters = 0;
  let usedMemory = 0;
  const originalRegisters = InstructionInfo.prototype.usedRegisters;
  const originalMemory = InstructionInfo.prototype.usedMemory;
  t.mock.method(InstructionInfo.prototype, 'usedRegisters', function (this: InstructionInfo) {
    const result = originalRegisters.call(this);
    usedRegisters += result.length;
    return result;
  });
  t.mock.method(InstructionInfo.prototype, 'usedMemory', function (this: InstructionInfo) {
    const result = originalMemory.call(this);
    usedMemory += result.length;
    return result;
  });
  const image = imageFromBytes(Uint8Array.from([0x48, 0x8b, 0x44, 0x24, 0x08, 0xf7, 0xe3, 0xc3]));
  const adapter = new X86Decoder({ formatting: true });
  const request = { image, regions: [region(image)], features: [], mode: 'long64' as const };
  let decodedInstructions = 0;
  try {
    for (let i = 0; i < 200; i++) {
      const result = adapter.decode(request, createOperationContext());
      assert.equal(result.instructions.length, 3);
      assert.equal(result.instructions.at(-1)?.flow.kind, 'return');
      assert.equal(adapter.format(result.instructions[0]!).mnemonic, 'mov');
      decodedInstructions += result.instructions.length;
    }
    assert.equal(freed['Instruction'], 200);
    assert.equal(freed['InstructionInfoFactory'], 200);
    assert.equal(freed['Decoder'], 200);
    assert.equal(freed['InstructionInfo'], decodedInstructions);
    assert.equal(freed['ConstantOffsets'], decodedInstructions);
    assert.equal(freed['OpCodeInfo'], decodedInstructions);
    assert.equal(freed['UsedRegister'], usedRegisters);
    assert.equal(freed['UsedMemory'], usedMemory);
    assert.equal(freed['Formatter'] ?? 0, 0);
    assert.throws(() => adapter.decode(request, createOperationContext({ budget: { work: 4 } })), OperationError);
    assert.equal(freed['Instruction'], 201);
    assert.equal(freed['InstructionInfoFactory'], 201);
    assert.equal(freed['Decoder'], 201);
    const afterError = adapter.decode(request, createOperationContext());
    assert.equal(afterError.instructions.length, 3);
  } finally { adapter.dispose(); adapter.dispose(); }
  assert.equal(freed['Formatter'], 1);
});

test('aborted requests allocate no transient decoder state and disabled formatting rejects presentation', () => {
  const image = imageFromBytes(Uint8Array.of(0xc3));
  const adapter = new X86Decoder({ formatting: false });
  const request = { image, regions: [region(image)], features: [], mode: 'long64' as const };
  try {
    const controller = new AbortController(); controller.abort();
    assert.throws(() => adapter.decode(request, createOperationContext({ signal: controller.signal })), OperationError);
    const result = adapter.decode(request, createOperationContext());
    assert.equal(result.instructions[0]?.flow.kind, 'return');
    assert.throws(() => adapter.format(result.instructions[0]!), /formatting-enabled/);
  } finally { adapter.dispose(); }
});
