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
  type X86Payload,
} from '../../../src/core/index.js';
import { ELFLoader } from '../../../src/loaders/elf/index.js';
import { X86Decoder } from '../../../src/decoders/x86_64/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { inspectELF } from '../../../scripts/fixtures/inspect-elf.js';

const bytes = readFileSync(new URL('./fixtures/abi.so', import.meta.url));
const sha256 = contentHash(bytes);
const image = new ELFLoader().load(
  { image_id: imageIdentity(sha256), sha256, bytes: new ImmutableBytes(bytes), slice_id: null },
  createOperationContext(),
);
const facts = inspectELF(bytes);
const u32: AbiType = { kind: 'integer', bits: 32, signed: false };
const u64: AbiType = { kind: 'integer', bits: 64, signed: false };
const f32: AbiType = { kind: 'float', bits: 32 };
const f64: AbiType = { kind: 'float', bits: 64 };
const mixed: AbiType = {
  kind: 'aggregate',
  size: 16n,
  alignment: 8,
  fields: [
    { offset: 0n, type: u64 },
    { offset: 8n, type: f64 },
  ],
};
const reverse: AbiType = {
  kind: 'aggregate',
  size: 16n,
  alignment: 8,
  fields: [
    { offset: 0n, type: f64 },
    { offset: 8n, type: u64 },
  ],
};
function signature(parameters: readonly AbiType[], returns: AbiType = f64) {
  return sysvAMD64Abi.classifyCall({
    parameters,
    returns,
    variadic: false,
    fixed_parameter_count: parameters.length,
  });
}
/** Only raw bytes enter the real decoder; LLVM text is independent review evidence. */
function decode(name: string): readonly DecodedInstruction[] {
  const fn = facts.functions.find((fn) => fn.name === name);
  assert.ok(fn, `Compiler STT_FUNC ${name}`);
  const decoder = new X86Decoder({ formatting: false });
  try {
    const result = decoder.decode(
      {
        image,
        regions: [
          {
            start: { image_id: image.id, space: 'va', value: BigInt(fn.address) },
            size: BigInt(fn.size),
          },
        ],
        features: [],
        mode: 'long64',
      },
      createOperationContext(),
    );
    assert.deepEqual(result.gaps, []);
    assert.ok(result.instructions.some((instruction) => instruction.flow.kind === 'return'));
    return result.instructions;
  } finally {
    decoder.dispose();
  }
}
function payload(instruction: DecodedInstruction): X86Payload {
  assert.ok(instruction.payload?.architecture === 'x86_64');
  return instruction.payload;
}
function root(location: AbiLocation | undefined): string {
  assert.ok(location?.kind === 'register');
  return location.register.root;
}
function reads(instructions: readonly DecodedInstruction[], register: string): boolean {
  return instructions.some((instruction) =>
    payload(instruction).registers.some(
      (access) => access.register.root === register && access.access.includes('read'),
    ),
  );
}
function writes(instructions: readonly DecodedInstruction[], register: string): boolean {
  return instructions.some((instruction) =>
    payload(instruction).registers.some(
      (access) => access.register.root === register && access.access.includes('write'),
    ),
  );
}
function stackRead(instructions: readonly DecodedInstruction[], offset: bigint): boolean {
  return instructions.some((instruction) =>
    payload(instruction).memory.some(
      (memory) =>
        memory.base?.root === 'x86_64:rsp' &&
        memory.displacement === offset &&
        memory.access === 'read',
    ),
  );
}

test('ELF source, recipe, raw bytes and independent LLVM reports remain hash-bound', () => {
  const evidence = JSON.parse(
    readFileSync(new URL('./fixtures/evidence.json', import.meta.url), 'utf8'),
  ) as { sha256: Record<string, string>; target_execution: string };
  for (const name of ['abi.c', 'generate.ts', 'abi.so', 'abi.disassembly.txt', 'abi.metadata.txt'])
    assert.equal(
      contentHash(readFileSync(new URL(`./fixtures/${name}`, import.meta.url))),
      evidence.sha256[name],
      name,
    );
  assert.equal(image.target.format, 'elf');
  assert.equal(image.target.abi, 'sysv-amd64');
  assert.ok(image.exports.some((entry) => entry.original_name === 'abi_mixed'));
  assert.match(evidence.target_execution, /never executed/);
});

test('compiler mixed scalars consume independent INTEGER and SSE argument banks', () => {
  const layout = signature([u32, f64, u32, f32, u64]);
  assert.deepEqual(
    layout.parameters.map((parameter) => root(parameter.locations[0])),
    ['x86_64:rdi', 'x86_64:zmm0', 'x86_64:rsi', 'x86_64:zmm1', 'x86_64:rdx'],
  );
  const instructions = decode('abi_mixed');
  for (const parameter of layout.parameters)
    assert.ok(reads(instructions, root(parameter.locations[0])));
  assert.equal(layout.shadow_space, 0n);
});

test('compiler mixed aggregate arguments retain exact source eightbyte offsets across both banks', () => {
  const layout = signature([mixed, reverse]),
    instructions = decode('abi_aggregate');
  assert.deepEqual(
    layout.parameters.map((parameter) => parameter.locations.map(root)),
    [
      ['x86_64:rdi', 'x86_64:zmm0'],
      ['x86_64:zmm1', 'x86_64:rsi'],
    ],
  );
  for (const parameter of layout.parameters) {
    assert.deepEqual(
      parameter.locations.map((location) =>
        location.kind === 'register' ? location.value_offset_bits : -1,
      ),
      [0, 64],
    );
    for (const location of parameter.locations) assert.ok(reads(instructions, root(location)));
  }
});

test('compiler aggregate rollback preserves unused SSE and INTEGER banks', () => {
  for (const [name, prefix, tailType, tailRoot] of [
    ['abi_rollback', Array.from({ length: 6 }, () => u64), f64, 'x86_64:zmm0'],
    ['abi_sse_rollback', Array.from({ length: 8 }, () => f64), u64, 'x86_64:rdi'],
  ] as const) {
    const layout = signature([...prefix, mixed, tailType]);
    const aggregate = layout.parameters[prefix.length]?.locations[0];
    assert.ok(aggregate?.kind === 'stack');
    assert.equal(aggregate.offset, 8n);
    assert.equal(aggregate.size, 16n);
    assert.equal(root(layout.parameters[prefix.length + 1]?.locations[0]), tailRoot);
    const instructions = decode(name);
    assert.ok(stackRead(instructions, aggregate.offset));
    assert.ok(stackRead(instructions, aggregate.offset + 8n));
    assert.ok(reads(instructions, tailRoot));
  }
});

test('compiler ninth SSE and seventh INTEGER arguments start at callee RSP+8', () => {
  for (const [name, count, type, registerCount] of [
    ['abi_sse_overflow', 9, f64, 8],
    ['abi_stack_args', 8, u64, 6],
  ] as const) {
    const layout = signature(Array.from({ length: count }, () => type));
    const instructions = decode(name);
    for (const parameter of layout.parameters.slice(registerCount)) {
      const location = parameter.locations[0];
      assert.ok(location?.kind === 'stack');
      assert.ok(location.offset >= 8n);
      assert.ok(stackRead(instructions, location.offset));
    }
  }
});

test('compiler split and mixed returns preserve eightbyte offsets and independent result banks', () => {
  const integers: AbiType = {
    kind: 'aggregate',
    size: 16n,
    alignment: 8,
    fields: [
      { offset: 0n, type: u64 },
      { offset: 8n, type: u64 },
    ],
  };
  const floats: AbiType = {
    kind: 'aggregate',
    size: 16n,
    alignment: 8,
    fields: [
      { offset: 0n, type: f64 },
      { offset: 8n, type: f64 },
    ],
  };
  for (const [name, parameters, returns, roots] of [
    ['abi_ret_integer', [u64, u64], integers, ['x86_64:rax', 'x86_64:rdx']],
    ['abi_ret_sse', [f64, f64], floats, ['x86_64:zmm0', 'x86_64:zmm1']],
    ['abi_ret_mixed', [u64, f64], mixed, ['x86_64:rax', 'x86_64:zmm0']],
    ['abi_ret_reverse', [f64, u64], reverse, ['x86_64:zmm0', 'x86_64:rax']],
  ] as const) {
    const layout = signature(parameters, returns);
    assert.equal(layout.hidden_result, null);
    assert.deepEqual(layout.returns.map(root), roots);
    assert.deepEqual(
      layout.returns.map((location) =>
        location.kind === 'register' ? location.value_offset_bits : -1,
      ),
      [0, 64],
    );
    const instructions = decode(name);
    for (const register of roots) assert.ok(writes(instructions, register));
  }
});

test('compiler large result uses hidden RDI buffer, shifted INTEGER arguments and RAX pointer result', () => {
  const large: AbiType = {
    kind: 'aggregate',
    size: 24n,
    alignment: 8,
    fields: [0n, 8n, 16n].map((offset) => ({ offset, type: u64 })),
  };
  const layout = signature([u64, u64], large),
    instructions = decode('abi_sret');
  const hidden = layout.hidden_result;
  assert.ok(hidden?.kind === 'indirect' && 'root' in hidden.pointer);
  assert.equal(hidden.pointer.root, 'x86_64:rdi');
  assert.deepEqual(
    layout.parameters.map((parameter) => root(parameter.locations[0])),
    ['x86_64:rsi', 'x86_64:rdx'],
  );
  assert.equal(root(layout.returns[0]), 'x86_64:rax');
  assert.ok(writes(instructions, 'x86_64:rax'));
  assert.ok(
    instructions.some((instruction) =>
      payload(instruction).memory.some(
        (memory) =>
          memory.access === 'write' &&
          ['x86_64:rdi', 'x86_64:rax'].includes(memory.base?.root ?? ''),
      ),
    ),
  );
});

test('compiler leaf uses negative RSP storage while larger indexed local allocates a stack frame', () => {
  const leaf = decode('abi_red_zone');
  assert.ok(
    leaf.some((instruction) =>
      payload(instruction).memory.some(
        (memory) =>
          memory.base?.root === 'x86_64:rsp' &&
          memory.displacement < 0n &&
          memory.displacement >= -128n &&
          memory.access === 'write',
      ),
    ),
  );
  assert.equal(
    leaf.some(
      (instruction) =>
        payload(instruction).mnemonic === 'sub' &&
        payload(instruction).operands[0]?.kind === 'register' &&
        payload(instruction).registers.some(
          (access) => access.register.root === 'x86_64:rsp' && access.access.includes('write'),
        ),
    ),
    false,
  );
  assert.ok(
    decode('abi_stack').some((instruction) => {
      const p = payload(instruction);
      return (
        p.mnemonic === 'sub' &&
        p.operands[0]?.kind === 'register' &&
        p.operands[0].register.root === 'x86_64:rsp' &&
        p.operands[1]?.kind === 'immediate' &&
        p.operands[1].value >= 128n
      );
    }),
  );
});

test('compiler variadic AL is within the ABI vector-register upper-bound interval', () => {
  const layout = sysvAMD64Abi.classifyCall({
    returns: f64,
    parameters: [u32, f64, f64],
    variadic: true,
    fixed_parameter_count: 1,
    argument_list_complete: true,
  });
  const requirement = layout.implicit_register_inputs.find(
    (input) => input.register.id === 'x86_64:al',
  );
  assert.ok(requirement);
  assert.equal(requirement.unsigned_minimum, 2n);
  assert.equal(requirement.unsigned_maximum, 8n);
  const instructions = decode('abi_call_variadic');
  const callIndex = instructions.findIndex((instruction) => instruction.flow.kind === 'call');
  assert.ok(callIndex >= 0);
  const assignment = instructions
    .slice(0, callIndex)
    .map(payload)
    .find(
      (p) =>
        p.mnemonic === 'mov' &&
        p.operands[0]?.kind === 'register' &&
        p.operands[0].register.root === 'x86_64:rax' &&
        p.operands[1]?.kind === 'immediate',
    );
  assert.ok(assignment?.operands[1]?.kind === 'immediate');
  const observedAL = BigInt.asUintN(8, assignment.operands[1].value);
  assert.ok(
    observedAL >= requirement.unsigned_minimum && observedAL <= requirement.unsigned_maximum,
  );
  assert.ok(
    reads(decode('abi_variadic'), 'x86_64:rax'),
    'Callee conditionally saves vector arguments based on AL',
  );
});

test('compiler long double object stride is sixteen bytes without pretending binary128 or x87 support', () => {
  assert.equal(sysvAMD64Abi.layout.long_double_bits, 80);
  assert.equal(sysvAMD64Abi.layout.long_double_storage_bits, 128);
  assert.ok(
    decode('abi_long_double_storage').some((instruction) =>
      payload(instruction).memory.some(
        (memory) =>
          memory.base?.root === 'x86_64:rdi' &&
          memory.displacement === 16n &&
          memory.access === 'read',
      ),
    ),
  );
  const extended = signature([], { kind: 'float', bits: 80 });
  assert.equal(extended.state, 'unsupported');
  assert.deepEqual(extended.returns, []);
});
