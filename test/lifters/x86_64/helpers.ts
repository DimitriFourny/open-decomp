import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ImmutableBytes,
  contentHash,
  createOperationContext,
  imageIdentity,
} from '../../../src/core/index.js';
import type { FunctionGraph, LoadedImage } from '../../../src/core/index.js';
import { X86Decoder } from '../../../src/decoders/x86_64/index.js';
import { discoverFunctions } from '../../../src/analysis/discovery/index.js';
import { WindowsX64Abi } from '../../../src/abi/windows-x64/index.js';
import { PELoader } from '../../../src/loaders/pe/index.js';
import { X86Lifter } from '../../../src/lifters/x86_64/index.js';
import { evaluateIR } from '../../../src/ir/index.js';
import type { EvaluationOptions, EvaluationResult, RegisterIR } from '../../../src/ir/index.js';
import { imageFromBytes } from '../../decoders/x86_64/helpers.js';

export function discover(image: LoadedImage): readonly FunctionGraph[] {
  const decoder = new X86Decoder({ formatting: false });
  try {
    return discoverFunctions({ image, decoder, revision: 0 }, createOperationContext()).graphs;
  } finally {
    decoder.dispose();
  }
}
export function liftBytes(hex: string) {
  const base = imageFromBytes(Buffer.from(hex.replaceAll(' ', ''), 'hex'));
  const image = {
    ...base,
    entry_points: [{ image_id: base.id, space: 'va' as const, value: base.image_base }],
  };
  const graph = discover(image)[0];
  assert.ok(graph);
  return { graph, ...new X86Lifter().lift(graph, new WindowsX64Abi(), createOperationContext()) };
}
export function loadCorpus() {
  const bytes = readFileSync('fixtures/bin/corpus-symbols.dll'),
    sha256 = contentHash(bytes);
  const image = new PELoader().load(
    { image_id: imageIdentity(sha256), sha256, bytes: new ImmutableBytes(bytes), slice_id: null },
    createOperationContext(),
  );
  const graphs = discover(image);
  return {
    image,
    graphs,
    lifted: new Map(
      graphs.map((graph) => [
        graph.function.entry.value,
        new X86Lifter().lift(graph, new WindowsX64Abi(), createOperationContext()),
      ]),
    ),
  };
}
/** Initialize every machine root, including SP and vector roots, not just C args. */
export function machineRegisters(
  ir: RegisterIR,
  supplied: Readonly<Record<string, bigint>> = {},
): Map<string, bigint> {
  const registers = new Map<string, bigint>();
  for (const block of ir.blocks)
    for (const instruction of block.instructions) {
      if (instruction.kind === 'read_register' || instruction.kind === 'write_register')
        registers.set(instruction.register.root, 0n);
      else if (instruction.kind === 'call' || instruction.kind === 'unknown_effect')
        for (const register of [...instruction.clobbers.registers, ...instruction.clobbers.flags])
          registers.set(register.root, 0n);
    }
  if (registers.has('x86_64:rsp')) registers.set('x86_64:rsp', 0x8808n);
  if (registers.has('x86_64:mxcsr')) registers.set('x86_64:mxcsr', 0x1f80n);
  for (const [name, value] of Object.entries(supplied)) {
    const root = name.startsWith('x86_64:') ? name : `x86_64:${name}`;
    assert.ok(registers.has(root), `Unused supplied root ${root}`);
    registers.set(root, value);
  }
  return registers;
}
export function run(
  ir: RegisterIR,
  registers: Readonly<Record<string, bigint>> = {},
  options: Omit<EvaluationOptions, 'registers'> = {},
): EvaluationResult {
  return evaluateIR(ir, {
    ...options,
    registers: machineRegisters(ir, registers),
    memory: [
      { base: 0x8000n, bytes: new Uint8Array(0x2000), writable: true },
      ...(options.memory ?? []),
    ],
  });
}
export function register(result: EvaluationResult, name: string, width = 64, offset = 0): bigint {
  assert.equal(result.status, 'returned', result.reason ?? 'Unexpected boundary');
  const state = result.registers.get(`x86_64:${name}`);
  assert.ok(state, `Missing register ${name}`);
  const mask = ((1n << BigInt(width)) - 1n) << BigInt(offset);
  assert.equal(state.known & mask, mask, `Unknown slice ${name}[${offset}:${offset + width}]`);
  return BigInt.asUintN(width, state.bits >> BigInt(offset));
}
