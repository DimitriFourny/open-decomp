// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ImmutableBytes,
  contentHash,
  createOperationContext,
  imageIdentity,
  type AbiLocation,
  type AbiType,
  type DecodedInstruction,
  type LoadedImage,
  type X86Payload,
} from '../../../src/core/index.js';
import { PELoader } from '../../../src/loaders/pe/index.js';
import { X86Decoder } from '../../../src/decoders/x86_64/index.js';
import { windowsX64Abi } from '../../../src/abi/windows-x64/index.js';

const u32: AbiType = { kind: 'integer', bits: 32, signed: false };
const u64: AbiType = { kind: 'integer', bits: 64, signed: false };
const f64: AbiType = { kind: 'float', bits: 64 };
const f32: AbiType = { kind: 'float', bits: 32 };
function load(url: URL): LoadedImage {
  const bytes = readFileSync(url);
  const sha256 = contentHash(bytes);
  return new PELoader().load(
    { image_id: imageIdentity(sha256), sha256, bytes: new ImmutableBytes(bytes), slice_id: null },
    createOperationContext(),
  );
}
const image = load(new URL('./fixtures/abi.dll', import.meta.url));
/** Decode real compiler PE bytes; disassembly text is independent human evidence, not parsed input. */
function decode(name: string, source = image): readonly DecodedInstruction[] {
  const entries = source.exports
    .filter((e) => e.address !== null)
    .sort((a, b) => (a.address!.value < b.address!.value ? -1 : 1));
  const index = entries.findIndex((e) => e.original_name === name);
  const start = entries[index]?.address;
  assert.ok(start, `Compiler export ${name}`);
  const section = source.sections.find(
    (s) =>
      start.value >= s.virtual_range.start.value &&
      start.value < s.virtual_range.start.value + s.virtual_range.size,
  );
  assert.ok(section);
  const end =
    entries[index + 1]?.address?.value ??
    section.virtual_range.start.value + section.virtual_range.size;
  const decoder = new X86Decoder({ formatting: false });
  try {
    const result = decoder.decode(
      {
        image: source,
        regions: [{ start, size: end - start.value }],
        features: [],
        mode: 'long64',
      },
      createOperationContext(),
    );
    assert.deepEqual(result.gaps, []);
    const stop = result.instructions.findIndex((instruction) => instruction.flow.kind === 'return');
    assert.ok(stop >= 0);
    return result.instructions.slice(0, stop + 1);
  } finally {
    decoder.dispose();
  }
}
function payload(instruction: DecodedInstruction | undefined): X86Payload {
  assert.ok(instruction?.payload?.architecture === 'x86_64');
  return instruction.payload;
}
function root(location: AbiLocation | undefined): string {
  assert.ok(location?.kind === 'register');
  return location.register.root;
}
function signature(parameters: readonly AbiType[], returns: AbiType = f64) {
  return windowsX64Abi.classifyCall({
    parameters,
    returns,
    variadic: false,
    fixed_parameter_count: parameters.length,
  });
}

test('ABI fixture PE/source/LLVM disassembly remain bound to recorded compiler provenance', () => {
  const evidence = JSON.parse(
    readFileSync(new URL('./fixtures/evidence.json', import.meta.url), 'utf8'),
  ) as { sha256: Record<string, string> };
  for (const name of ['abi.c', 'abi.dll', 'abi.disassembly.txt'])
    assert.equal(
      contentHash(readFileSync(new URL(`./fixtures/${name}`, import.meta.url))),
      evidence.sha256[name],
    );
  assert.equal(image.target.abi, 'windows-x64');
  assert.equal(image.target.format, 'pe');
  assert.equal(image.exports.length, 10);
});

test('compiler mixed C arguments use ECX/XMM1/R8D/XMM3 and entry-RSP+40', () => {
  const instructions = decode('abi_mixed');
  const layout = signature([u32, f64, u32, f32, u64]);
  const firstSource = payload(instructions[0]).operands[1];
  assert.ok(firstSource?.kind === 'register');
  assert.equal(firstSource.register.root, root(layout.parameters[0]?.locations[0]));
  for (const index of [1, 2, 3]) {
    const expected = root(layout.parameters[index]?.locations[0]);
    assert.ok(
      instructions.some((instruction) =>
        payload(instruction).registers.some(
          (access) => access.register.root === expected && access.access.includes('read'),
        ),
      ),
    );
  }
  const stack = layout.parameters[4]?.locations[0];
  assert.ok(stack?.kind === 'stack');
  assert.equal(stack.offset, 40n);
  assert.ok(
    instructions.some((instruction) =>
      payload(instruction).memory.some(
        (memory) =>
          memory.base?.root === windowsX64Abi.stack_pointer.root &&
          memory.displacement === stack.offset &&
          memory.access === 'read',
      ),
    ),
  );
  const lastValue = payload(instructions.at(-2)).operands[0];
  assert.ok(lastValue?.kind === 'register');
  assert.equal(lastValue.register.root, root(layout.returns[0]));
});

test('compiler 8-byte aggregate returns RAX but 12/16-byte results use hidden RCX', () => {
  const small = signature([u32, u32], { kind: 'aggregate', size: 8n, alignment: 4, fields: [] });
  assert.equal(small.hidden_result, null);
  const smallWrites = decode('abi_ret8')
    .flatMap((instruction) => payload(instruction).registers)
    .filter((access) => access.access.includes('write'));
  assert.ok(smallWrites.some((access) => access.register.root === root(small.returns[0])));
  for (const [name, size] of [
    ['abi_sret12', 12n],
    ['abi_sret16', 16n],
  ] as const) {
    const parameters = size === 12n ? [u32, f64, u32, f32] : [u64, u64];
    const layout = signature(parameters, {
      kind: 'aggregate',
      size,
      alignment: size === 12n ? 4 : 8,
      fields: [],
    });
    const instructions = decode(name);
    const copy = payload(instructions[0]);
    assert.equal(copy.mnemonic, 'mov');
    assert.ok(copy.operands[0]?.kind === 'register' && copy.operands[1]?.kind === 'register');
    assert.equal(copy.operands[0].register.root, root(layout.returns[0]));
    assert.ok(layout.hidden_result?.kind === 'indirect' && 'root' in layout.hidden_result.pointer);
    assert.equal(copy.operands[1].register.root, layout.hidden_result.pointer.root);
    const resultRoot = copy.operands[0].register.root;
    const hiddenRoot = copy.operands[1].register.root;
    // The initial MOV establishes these two registers as aliases of the same buffer.
    assert.ok(
      instructions.some((instruction) =>
        payload(instruction).memory.some(
          (memory) =>
            memory.access === 'write' &&
            (memory.base?.root === resultRoot || memory.base?.root === hiddenRoot),
        ),
      ),
    );
    if (size === 12n) {
      const last = layout.parameters[3]?.locations[0];
      assert.ok(last?.kind === 'stack');
      assert.ok(
        instructions.some((instruction) =>
          payload(instruction).memory.some(
            (memory) =>
              memory.base?.id === 'x86_64:rsp' &&
              memory.displacement === last.offset &&
              memory.access === 'read',
          ),
        ),
      );
      assert.equal(root(layout.parameters[1]?.locations[0]), 'x86_64:zmm2');
    }
  }
});

test('compiler aggregate/vector inputs use pointers while __m128 returns use XMM0', () => {
  const aggregate: AbiType = { kind: 'aggregate', size: 3n, alignment: 1, fields: [] };
  const small: AbiType = { kind: 'aggregate', size: 8n, alignment: 4, fields: [] };
  const layout = signature([aggregate, small], u32);
  const indirect = layout.parameters[0]?.locations[0];
  assert.ok(indirect?.kind === 'indirect' && 'root' in indirect.pointer);
  const pointerRoot = indirect.pointer.root;
  assert.ok(
    decode('abi_aggregate').some((instruction) =>
      payload(instruction).memory.some(
        (memory) => memory.base?.root === pointerRoot && memory.access === 'read',
      ),
    ),
  );
  const vector: AbiType = { kind: 'vector', element: 'float', element_bits: 32, lanes: 4 };
  const vectorLayout = signature([vector], vector);
  const load = payload(decode('abi_vector')[0]);
  assert.ok(load.operands[0]?.kind === 'register' && load.operands[1]?.kind === 'memory');
  assert.equal(load.operands[0].register.root, root(vectorLayout.returns[0]));
  const vectorPointer = vectorLayout.parameters[0]?.locations[0];
  assert.ok(vectorPointer?.kind === 'indirect' && 'root' in vectorPointer.pointer);
  assert.equal(load.operands[1].memory.base?.root, vectorPointer.pointer.root);
});

test('compiler generic 64-bit vectors are not shape-equivalent to __m64 ABI identity', () => {
  const first = payload(decode('abi_vector64')[0]);
  assert.ok(first.operands[0]?.kind === 'register' && first.operands[1]?.kind === 'memory');
  assert.equal(first.operands[0].register.root, 'x86_64:zmm0');
  assert.equal(first.operands[1].memory.base?.root, 'x86_64:rcx');
  const vector: AbiType = { kind: 'vector', element: 'integer', element_bits: 32, lanes: 2 };
  assert.equal(signature([vector], vector).state, 'unsupported');
});

test('compiler variadic caller duplicates XMM1 into RDX and reserves shadow space', () => {
  const layout = windowsX64Abi.classifyCall({
    returns: f64,
    parameters: [u32, f64],
    variadic: true,
    fixed_parameter_count: 1,
    argument_list_complete: true,
  });
  const instructions = decode('abi_call_variadic');
  const first = payload(instructions[0]);
  assert.equal(first.mnemonic, 'sub');
  assert.ok(first.operands[1]?.kind === 'immediate');
  // The extra 8 aligns this caller's own entry RSP (8 mod 16); it is not
  // another home slot nor the CALL instruction's hardware return-address push.
  assert.equal(first.operands[1].value, layout.stack_bytes + 8n);
  assert.ok(
    instructions.some((instruction) => {
      const p = payload(instruction);
      return (
        p.mnemonic === 'movq' &&
        p.operands[0]?.kind === 'register' &&
        p.operands[1]?.kind === 'register' &&
        p.operands[0].register.root === root(layout.parameters[1]?.locations[1]) &&
        p.operands[1].register.root === root(layout.parameters[1]?.locations[0])
      );
    }),
  );
  assert.ok(
    instructions.some(
      (instruction) => instruction.flow.kind === 'call' && instruction.flow.target !== null,
    ),
  );
});

test('compiler spills/restores XMM6 low128 across call with matching ABI root descriptors', () => {
  const instructions = decode('abi_preserve');
  const save = payload(instructions[1]);
  const restore = payload(instructions.at(-3));
  assert.equal(save.mnemonic, 'movaps');
  assert.equal(restore.mnemonic, 'movaps');
  assert.ok(save.operands[1]?.kind === 'register' && restore.operands[0]?.kind === 'register');
  const retained = windowsX64Abi.preserved.find((r) => r.id === 'x86_64:xmm6');
  assert.deepEqual(save.operands[1].register, retained);
  assert.deepEqual(restore.operands[0].register, retained);
  assert.ok(
    instructions.some(
      (instruction) => instruction.flow.kind === 'call' && instruction.flow.indirect,
    ),
  );
  assert.ok(
    windowsX64Abi.unknown_call_clobbers.registers.some(
      (r) => r.root === retained?.root && r.offset_bits === 128 && r.width_bits === 384,
    ),
  );
  assert.ok(
    image.hints.some(
      (hint) => hint.kind === 'unwind' && hint.range.start.value === instructions[0]?.address.value,
    ),
  );
  const unknown = windowsX64Abi.classifyCall({
    returns: { kind: 'unknown', size: null },
    parameters: null,
    variadic: false,
    fixed_parameter_count: 0,
  });
  assert.deepEqual(unknown.parameters, []);
  assert.equal(unknown.state, 'partial');
});

test('existing ten-argument compiler corpus loads fifth ordinary argument at entry RSP+40', () => {
  const corpus = load(new URL('../../../fixtures/bin/corpus-symbols.dll', import.meta.url));
  const instructions = decode('fixture_stack_args', corpus);
  const layout = signature(
    Array.from({ length: 10 }, () => u64),
    u64,
  );
  // Source compiler preserved RSI/RDI/RBX by three pushes before its loads.
  assert.ok(
    instructions.slice(0, 3).every((instruction) => payload(instruction).mnemonic === 'push'),
  );
  const stackLoads = instructions
    .flatMap((instruction) =>
      payload(instruction).operands.flatMap((operand) =>
        operand.kind === 'memory' ? [operand.memory] : [],
      ),
    )
    .filter((memory) => memory.base?.id === 'x86_64:rsp' && memory.access === 'read');
  const offsets = stackLoads
    .map((memory) => memory.displacement - 24n)
    .sort((a, b) => (a < b ? -1 : 1));
  assert.deepEqual(
    offsets,
    layout.parameters.slice(4).map((parameter) => {
      const location = parameter.locations[0];
      assert.ok(location?.kind === 'stack');
      return location.offset;
    }),
  );
  for (const name of ['rsi', 'rdi', 'rbx'])
    assert.ok(windowsX64Abi.preserved.some((r) => r.id === `x86_64:${name}`));
});
