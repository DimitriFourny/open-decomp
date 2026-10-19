import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AddressMap,
  ImmutableBytes,
  contentHash,
  createOperationContext,
  fingerprint,
  imageIdentity,
  sliceIdentity,
  type Evidence,
  type LoadedImage,
} from '../../src/core/index.js';
import { Arm64Decoder } from '../../src/decoders/arm64/index.js';
import {
  discoverFunctions,
  type DiscoveryResult,
  type FunctionAssertion,
} from '../../src/analysis/discovery/index.js';

/** ARM64 `switch (w0) { 0..2 }` through an `adr` base plus `ldrb` word offsets. */
const CODE = [
  0x7100081f, // 0x1000 cmp w0, #2
  0x540001a8, // 0x1004 b.hi 0x1038
  0x2a0003e8, // 0x1008 mov w8, w0
  0x100001a9, // 0x100c adr x9, 0x1040 (table)
  0x1000008a, // 0x1010 adr x10, 0x1020
  0x3868692b, // 0x1014 ldrb w11, [x9, x8]
  0x8b0b094a, // 0x1018 add x10, x10, x11, lsl #2
  0xd61f0140, // 0x101c br x10
  0xd2800020, // 0x1020 mov x0, #1
  0xd65f03c0, // 0x1024 ret
  0xd2800040, // 0x1028 mov x0, #2
  0xd65f03c0, // 0x102c ret
  0xd2800060, // 0x1030 mov x0, #3
  0xd65f03c0, // 0x1034 ret
  0xd2800120, // 0x1038 mov x0, #9
  0xd65f03c0, // 0x103c ret
];
const NOP = 0xd503201f;

function image(
  options: { words?: readonly number[]; table?: readonly number[]; writable?: boolean } = {},
): LoadedImage {
  const words = options.words ?? CODE;
  const buffer = new Uint8Array(words.length * 4 + 4);
  const view = new DataView(buffer.buffer);
  words.forEach((word, index) => view.setUint32(index * 4, word, true));
  buffer.set(options.table ?? [0, 2, 4, 0], words.length * 4);
  const sha256 = contentHash(buffer);
  const id = imageIdentity(sha256);
  const slice = sliceIdentity(id, 0n, BigInt(buffer.length), 'arm64');
  const mappings = [
    {
      id: 'test-code',
      va: 0x1000n,
      memory_size: BigInt(buffer.length),
      file_offset: 0n,
      file_size: BigInt(buffer.length),
      permissions: ['read', 'execute'] as const,
    },
  ];
  const va = (value: bigint) => ({ image_id: id, space: 'va' as const, value });
  const table = BigInt(words.length * 4);
  return {
    id,
    sha256,
    selected_slice_id: slice,
    bytes: new ImmutableBytes(buffer),
    image_base: 0x1000n,
    slices: [
      {
        id: slice,
        image_id: id,
        offset: 0n,
        size: BigInt(buffer.length),
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
      features: [],
    },
    mappings,
    address_map: new AddressMap({
      image_id: id,
      image_base: 0x1000n,
      byte_length: BigInt(buffer.length),
      slice_offset: 0n,
      slice_size: BigInt(buffer.length),
      mappings,
    }),
    entry_points: [va(0x1000n)],
    hints: [],
    headers: [],
    sections: [
      {
        id: 'section-text',
        name: '__text',
        segment_id: null,
        kind: 'section',
        virtual_range: { start: va(0x1000n), size: table },
        file_range: { start: { image_id: id, space: 'file', value: 0n }, size: table },
        permissions: ['read', 'execute'],
        flags: 0n,
        evidence_ids: [],
      },
      {
        id: 'section-const',
        name: '__const',
        segment_id: null,
        kind: 'section',
        virtual_range: { start: va(0x1000n + table), size: 4n },
        file_range: { start: { image_id: id, space: 'file', value: table }, size: 4n },
        permissions: options.writable ? ['read', 'write'] : ['read'],
        flags: 0n,
        evidence_ids: [],
      },
    ],
    symbols: [],
    imports: [],
    exports: [],
    relocations: [],
    evidence: [],
    diagnostics: [],
    capabilities: [],
  };
}

function discover(loaded: LoadedImage, assertions: readonly FunctionAssertion[] = []) {
  const decoder = new Arm64Decoder();
  try {
    return discoverFunctions(
      { image: loaded, decoder, revision: 0, assertions },
      createOperationContext(),
    );
  } finally {
    decoder.dispose();
  }
}

const root = (result: DiscoveryResult) =>
  result.graphs.find((graph) => graph.function.entry.value === 0x1000n)!;

test('bounded immutable jump table resolves to exact CFG targets', () => {
  const graph = root(discover(image()));
  assert.equal(graph.jump_tables?.length, 1);
  const table = graph.jump_tables![0]!;
  assert.deepEqual(
    table.targets.map((target) => target.value),
    [0x1020n, 0x1028n, 0x1030n],
  );
  assert.equal(table.otherwise.value, 0x1038n);
  assert.equal(table.guard_exact, true);
  assert.deepEqual(table.entry, { bytes: 1, signed: false, stride: 1 });
  assert.equal(table.selector.register.root, 'arm64:x8');
  assert.equal(graph.coverage.state, 'complete');
  const branch = graph.blocks.find((block) =>
    block.edges.some((edge) => edge.target?.value === 0x1028n),
  );
  assert.deepEqual(
    branch?.edges.map((edge) => [edge.kind, edge.target?.value]),
    [
      ['branch', 0x1020n],
      ['branch', 0x1028n],
      ['branch', 0x1030n],
    ],
  );
  // Case bodies are decoded members.
  for (const address of [0x1020n, 0x1028n, 0x1030n])
    assert.ok(graph.instructions.some((instruction) => instruction.address.value === address));
});

test('jump table without a dominating bound stays unresolved', () => {
  const words = [...CODE];
  words[1] = NOP;
  const graph = root(discover(image({ words })));
  assert.equal(graph.jump_tables, undefined);
  assert.ok(graph.coverage.reasons.includes('unresolved control flow'));
  assert.ok(graph.blocks.some((block) => block.edges.some((edge) => edge.kind === 'unknown')));
});

test('writable jump table bytes stay unresolved', () => {
  const graph = root(discover(image({ writable: true })));
  assert.equal(graph.jump_tables, undefined);
  assert.ok(graph.coverage.reasons.includes('unresolved control flow'));
});

test('jump table target outside the function stays unresolved', () => {
  const loaded = image();
  const evidence: Evidence = {
    id: `evidence_${fingerprint(['jump-table-test', 0x1030])}`,
    origin: { kind: 'assertion', author: 'test', agent: 'user', status: 'asserted' },
    claim: 'Function entry',
    derived_from: [],
    conflicts_with: [],
    revision: 1,
  };
  // Case 2 lands on another function's entry.
  const graph = root(
    discover(loaded, [{ entry: { image_id: loaded.id, space: 'va', value: 0x1030n }, evidence }]),
  );
  assert.equal(graph.jump_tables, undefined);
  assert.ok(graph.coverage.reasons.includes('unresolved control flow'));
});

test('jump table entry landing outside executable code stays unresolved', () => {
  const graph = root(discover(image({ table: [0, 2, 0xff, 0] })));
  assert.equal(graph.jump_tables, undefined);
});
