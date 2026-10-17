import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AddressMap,
  ImmutableBytes,
  contentHash,
  createOperationContext,
  imageIdentity,
  sliceIdentity,
  type FunctionGraph,
  type LoadedImage,
  type RegisterDescriptor,
} from '../../../src/core/index.js';
import { Arm64Decoder } from '../../../src/decoders/arm64/index.js';
import { discoverFunctions } from '../../../src/analysis/discovery/index.js';
import { DarwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { MachOLoader } from '../../../src/loaders/macho/index.js';
import { Arm64Lifter, type Arm64LiftResult } from '../../../src/lifters/arm64/index.js';
import {
  evaluateIR,
  type EvaluationOptions,
  type EvaluationResult,
  type RegisterIR,
} from '../../../src/ir/index.js';

export const stack = 0x700001000n;
export const data = 0x710000000n;
export function machineRegister(index: number): RegisterDescriptor {
  return {
    id: `arm64:x${index}`,
    root: `arm64:x${index}`,
    bank: 'integer',
    offset_bits: 0,
    width_bits: 64,
    root_width_bits: 64,
    role: 'general',
    write_rule: 'replace_root',
  };
}
export function initialRegisters(
  ir: RegisterIR,
  overrides: ReadonlyMap<string, bigint> = new Map(),
): Map<string, bigint> {
  const state = new Map<string, bigint>();
  for (const block of ir.blocks)
    for (const node of block.instructions) {
      if (node.kind === 'read_register' || node.kind === 'write_register')
        state.set(node.register.root, 0n);
      if (node.kind === 'call' || node.kind === 'unknown_effect')
        for (const register of [...node.clobbers.registers, ...node.clobbers.flags])
          state.set(register.root, 0n);
    }
  if (state.has('arm64:sp')) state.set('arm64:sp', stack);
  for (const [root, bits] of overrides) {
    assert.ok(state.has(root), `Unused machine input ${root}`);
    state.set(root, bits);
  }
  return state;
}
export function discover(image: LoadedImage): readonly FunctionGraph[] {
  const decoder = new Arm64Decoder();
  try {
    return discoverFunctions({ image, decoder, revision: 0 }, createOperationContext()).graphs;
  } finally {
    decoder.dispose();
  }
}
export function loadCorpus(): LoadedImage {
  const input = readFileSync('fixtures/bin/libcorpus-arm64-symbols.dylib');
  const sha256 = contentHash(input),
    image_id = imageIdentity(sha256);
  return new MachOLoader().load(
    { image_id, sha256, bytes: new ImmutableBytes(input), slice_id: null },
    createOperationContext(),
  );
}
export function lift(graph: FunctionGraph): Arm64LiftResult {
  return new Arm64Lifter().lift(graph, new DarwinArm64Abi(), createOperationContext());
}
export function fromWords(
  words: readonly number[],
  features: readonly string[] = ['FEAT_FP', 'FEAT_AdvSIMD', 'FEAT_PAuth'],
): FunctionGraph {
  const raw = new Uint8Array(words.length * 4),
    view = new DataView(raw.buffer);
  words.forEach((word, i) => view.setUint32(i * 4, word, true));
  const sha256 = contentHash(raw),
    id = imageIdentity(sha256),
    selected_slice_id = sliceIdentity(id, 0n, BigInt(raw.length), 'arm64');
  const base = 0x1000n,
    address = { image_id: id, space: 'va' as const, value: base };
  const mappings = [
    {
      id: 'code',
      va: base,
      memory_size: BigInt(raw.length),
      file_offset: 0n,
      file_size: BigInt(raw.length),
      permissions: ['read', 'execute'] as const,
    },
  ];
  const image: LoadedImage = {
    id,
    sha256,
    bytes: new ImmutableBytes(raw),
    selected_slice_id,
    slices: [
      {
        id: selected_slice_id,
        image_id: id,
        offset: 0n,
        size: BigInt(raw.length),
        architecture: 'arm64',
        subtype: 'all',
        supported: true,
      },
    ],
    target: {
      format: 'macho',
      architecture: 'arm64',
      abi: 'darwin-arm64',
      endian: 'little',
      address_bits: 64,
      features: [...features],
    },
    image_base: base,
    address_map: new AddressMap({
      image_id: id,
      image_base: base,
      byte_length: BigInt(raw.length),
      slice_offset: 0n,
      slice_size: BigInt(raw.length),
      mappings,
    }),
    mappings,
    hints: [],
    headers: [],
    sections: [],
    entry_points: [address],
    symbols: [],
    imports: [],
    exports: [],
    relocations: [],
    evidence: [],
    diagnostics: [],
    capabilities: [],
  };
  const graph = discover(image).find((item) => item.function.entry.value === base);
  assert.ok(graph, 'Discovery must establish the real-byte entry');
  return graph;
}
export function evaluate(
  ir: RegisterIR,
  inputs: ReadonlyMap<string, bigint> = new Map(),
  options: EvaluationOptions = {},
): EvaluationResult {
  return evaluateIR(ir, {
    registers: initialRegisters(ir, inputs),
    memory: [{ base: stack - 4096n, bytes: new Uint8Array(8192), writable: true }],
    ...options,
  });
}
export function registerBits(result: EvaluationResult, root = 'arm64:x0', width = 64): bigint {
  assert.equal(result.status, 'returned', result.reason ?? undefined);
  const register = result.registers.get(root);
  assert.ok(register, root);
  const mask = (1n << BigInt(width)) - 1n;
  assert.equal(register.known & mask, mask, `${root} must have known output bits`);
  return register.bits & mask;
}
export function floatBits(value: number, width: 32 | 64): bigint {
  const view = new DataView(new ArrayBuffer(8));
  if (width === 32) {
    view.setFloat32(0, value, true);
    return BigInt(view.getUint32(0, true));
  }
  view.setFloat64(0, value, true);
  return view.getBigUint64(0, true);
}
