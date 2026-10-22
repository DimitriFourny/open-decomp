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
  type FunctionGraph,
  type LoadedImage,
} from '../../src/core/index.js';
import { Arm64Decoder } from '../../src/decoders/arm64/index.js';
import { X86Decoder } from '../../src/decoders/x86_64/index.js';
import { DarwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import { SysVAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import {
  discoverFunctions,
  prepareDiscoveryIndex,
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
  options: {
    words?: readonly number[];
    table?: readonly number[];
    writable?: boolean;
    /** Raw x86-64 code bytes (an ELF SysV image) instead of ARM64 words. */
    x86?: readonly number[];
    /** Target decoder features, such as `FEAT_PAuth` for valid pointer-authentication hints. */
    features?: readonly string[];
  } = {},
): LoadedImage {
  const words = options.words ?? CODE;
  const code = options.x86 ?? [];
  const table = BigInt(options.x86 ? code.length : words.length * 4);
  const entries = options.table ?? [0, 2, 4, 0];
  const buffer = new Uint8Array(Number(table) + entries.length);
  const view = new DataView(buffer.buffer);
  if (options.x86) buffer.set(code);
  else words.forEach((word, index) => view.setUint32(index * 4, word, true));
  buffer.set(entries, Number(table));
  const architecture = options.x86 ? 'x86_64' : 'arm64';
  const sha256 = contentHash(buffer);
  const id = imageIdentity(sha256);
  const slice = sliceIdentity(id, 0n, BigInt(buffer.length), architecture);
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
        architecture,
        subtype: 'all',
        supported: true,
      },
    ],
    target: options.x86
      ? {
          format: 'elf',
          architecture: 'x86_64',
          abi: 'sysv-amd64',
          endian: 'little',
          address_bits: 64,
          features: [],
        }
      : {
          format: 'macho',
          architecture: 'arm64',
          abi: 'darwin-arm64',
          endian: 'little',
          address_bits: 64,
          features: [...(options.features ?? [])],
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
        name: options.x86 ? '.text' : '__text',
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
        name: options.x86 ? '.rodata' : '__const',
        segment_id: null,
        kind: 'section',
        virtual_range: { start: va(0x1000n + table), size: BigInt(entries.length) },
        file_range: {
          start: { image_id: id, space: 'file', value: table },
          size: BigInt(entries.length),
        },
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

/** The image ABI's callee-saved registers, as the service passes them to discovery. */
const preserved = (loaded: LoadedImage) =>
  (loaded.target.architecture === 'arm64' ? new DarwinArm64Abi() : new SysVAMD64Abi()).preserved;

function discover(
  loaded: LoadedImage,
  assertions: readonly FunctionAssertion[] = [],
  options: { readonly abi?: boolean } = {},
) {
  const decoder =
    loaded.target.architecture === 'arm64'
      ? new Arm64Decoder()
      : new X86Decoder({ formatting: false });
  try {
    return discoverFunctions(
      {
        image: loaded,
        decoder,
        revision: 0,
        assertions,
        ...(options.abi ? { preserved_registers: preserved(loaded) } : {}),
      },
      createOperationContext(),
    );
  } finally {
    decoder.dispose();
  }
}

/** Selected-root discovery of 0x1000, as a decompile request runs it. */
function discoverSelected(loaded: LoadedImage, options: { readonly abi?: boolean } = {}) {
  const decoder =
    loaded.target.architecture === 'arm64'
      ? new Arm64Decoder()
      : new X86Decoder({ formatting: false });
  try {
    const context = createOperationContext();
    const index = prepareDiscoveryIndex({ image: loaded, revision: 0 }, context);
    return discoverFunctions(
      {
        image: loaded,
        decoder,
        revision: 0,
        index,
        selected_entry: { image_id: loaded.id, space: 'va', value: 0x1000n },
        ...(options.abi ? { preserved_registers: preserved(loaded) } : {}),
      },
      context,
    );
  } finally {
    decoder.dispose();
  }
}

const root = (result: DiscoveryResult) =>
  result.graphs.find((graph) => graph.function.entry.value === 0x1000n)!;

const entryAssertion = (loaded: LoadedImage, value: bigint): FunctionAssertion => ({
  entry: { image_id: loaded.id, space: 'va', value },
  evidence: {
    id: `evidence_${fingerprint(['jump-table-test', Number(value)])}`,
    origin: { kind: 'assertion', author: 'test', agent: 'user', status: 'asserted' },
    claim: 'Function entry',
    derived_from: [],
    conflicts_with: [],
    revision: 1,
  },
});

const members = (graph: FunctionGraph) =>
  new Set(graph.instructions.map((instruction) => instruction.address.value));

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

/** `b L1; L1: sub w8, w0, #1; cmp w8, #2; b.hi out; adr; adr; ldrb; add …, lsl #2; br`, where
 * case 2 decrements w0 and branches back to L1. The loop gives L1 a second predecessor only
 * after the table's targets decode, so the first proof's chain (from the entry) goes stale. */
const LOOP = [
  0x14000001, // 0x1000 b 0x1004
  0x51000408, // 0x1004 L1: sub w8, w0, #1
  0x7100091f, // 0x1008 cmp w8, #2
  0x54000188, // 0x100c b.hi 0x103c
  0x100001a9, // 0x1010 adr x9, 0x1044 (table)
  0x1000008a, // 0x1014 adr x10, 0x1024
  0x3868692b, // 0x1018 ldrb w11, [x9, x8]
  0x8b0b094a, // 0x101c add x10, x10, x11, lsl #2
  0xd61f0140, // 0x1020 br x10
  0xd2800020, // 0x1024 mov x0, #1
  0xd65f03c0, // 0x1028 ret
  0xd2800040, // 0x102c mov x0, #2
  0xd65f03c0, // 0x1030 ret
  0x51000400, // 0x1034 sub w0, w0, #1
  0x17fffff3, // 0x1038 b 0x1004
  0xd2800120, // 0x103c mov x0, #9
  0xd65f03c0, // 0x1040 ret
];

test('jump table is re-proved on its settled chain after a case loops back into it', () => {
  const loaded = image({ words: LOOP });
  for (const graph of [root(discover(loaded)), root(discoverSelected(loaded))]) {
    assert.equal(graph.jump_tables?.length, 1);
    const table = graph.jump_tables![0]!;
    assert.deepEqual(
      table.targets.map((target) => target.value),
      [0x1024n, 0x102cn, 0x1034n],
    );
    assert.equal(table.otherwise.value, 0x103cn);
    assert.equal(table.guard_exact, true);
    // The proof starts at L1, which now has two predecessors (the entry jump and the loop).
    const chain = table.chain.map(
      (id) => graph.instructions.find((instruction) => instruction.id === id)!.address.value,
    );
    assert.equal(chain[0], 0x1004n);
    assert.equal(graph.coverage.state, 'complete');
    const body = members(graph);
    for (const address of [0x1024n, 0x102cn, 0x1034n, 0x1038n, 0x103cn])
      assert.ok(body.has(address), `0x${address.toString(16)} is a member`);
  }
});

test('jump table guarded before a loop header stays unresolved once the loop decodes', () => {
  // `sub w8, w0, #1; cmp w8, #2; b.hi out; L1: adr; adr; ldrb; add; br`, and case 2 adds 5 to
  // w8 and branches back to L1: the index at L1 is no longer bounded, so the first proof
  // (whose chain ran from the entry through the guard) must not survive.
  const words = [
    0x51000408, // 0x1000 sub w8, w0, #1
    0x7100091f, // 0x1004 cmp w8, #2
    0x54000188, // 0x1008 b.hi 0x1038
    0x100001a9, // 0x100c L1: adr x9, 0x1040 (table)
    0x1000008a, // 0x1010 adr x10, 0x1020
    0x3868692b, // 0x1014 ldrb w11, [x9, x8]
    0x8b0b094a, // 0x1018 add x10, x10, x11, lsl #2
    0xd61f0140, // 0x101c br x10
    0xd2800020, // 0x1020 mov x0, #1
    0xd65f03c0, // 0x1024 ret
    0xd2800040, // 0x1028 mov x0, #2
    0xd65f03c0, // 0x102c ret
    0x11001508, // 0x1030 add w8, w8, #5
    0x17fffff6, // 0x1034 b 0x100c
    0xd2800120, // 0x1038 mov x0, #9
    0xd65f03c0, // 0x103c ret
  ];
  const loaded = image({ words });
  for (const graph of [root(discover(loaded)), root(discoverSelected(loaded))]) {
    assert.equal(graph.jump_tables, undefined);
    assert.equal(graph.coverage.state, 'partial');
    assert.ok(graph.coverage.reasons.includes('unresolved control flow'));
    assert.ok(graph.blocks.some((block) => block.edges.some((edge) => edge.kind === 'unknown')));
    const body = members(graph);
    for (const address of [0x1020n, 0x1028n, 0x1030n])
      assert.ok(!body.has(address), `0x${address.toString(16)} is no member`);
  }
});

test("a table whose chain fails in its graph is re-proved on the graph's own predecessors", () => {
  // A: `cmp w0, #1; b.hi out; L1: mov w8, w0; cmp w8, #2; b.hi out; adr; adr; ldrb; add; br`.
  // Case 2 (0x1038) is root B, `b L1`. Image-wide, L1 has two predecessors, so the proof starts
  // at L1 and its bound 2 reaches B, which A cannot own. In A's graph, L1's only predecessor is
  // A's own `b.hi`: the longer chain carries A's tighter guard and proves cases 0 and 1.
  const words = [
    0x7100041f, // 0x1000 cmp w0, #1
    0x540001c8, // 0x1004 b.hi 0x103c
    0x2a0003e8, // 0x1008 L1: mov w8, w0
    0x7100091f, // 0x100c cmp w8, #2
    0x54000168, // 0x1010 b.hi 0x103c
    0x100001a9, // 0x1014 adr x9, 0x1048 (table)
    0x1000008a, // 0x1018 adr x10, 0x1028
    0x3868692b, // 0x101c ldrb w11, [x9, x8]
    0x8b0b094a, // 0x1020 add x10, x10, x11, lsl #2
    0xd61f0140, // 0x1024 br x10
    0xd2800020, // 0x1028 mov x0, #1
    0xd65f03c0, // 0x102c ret
    0xd2800040, // 0x1030 mov x0, #2
    0xd65f03c0, // 0x1034 ret
    0x17fffff4, // 0x1038 B: b 0x1008
    0xd2800120, // 0x103c mov x0, #9
    0xd65f03c0, // 0x1040 ret
    NOP, // 0x1044
  ];
  const loaded = image({ words });
  const result = discover(loaded, [entryAssertion(loaded, 0x1038n)]);
  const graph = root(result);
  assert.equal(graph.jump_tables?.length, 1);
  const table = graph.jump_tables![0]!;
  assert.deepEqual(
    table.targets.map((target) => target.value),
    [0x1028n, 0x1030n],
  );
  assert.equal(table.otherwise.value, 0x103cn);
  assert.equal(graph.coverage.state, 'complete');
  assert.ok(!members(graph).has(0x1038n));
  // B reaches the table through its own jump; its graph keeps the image-wide 3-target proof.
  const other = result.graphs.find((item) => item.function.entry.value === 0x1038n)!;
  assert.deepEqual(
    other.jump_tables?.[0]?.targets.map((target) => target.value),
    [0x1028n, 0x1030n, 0x1038n],
  );
});

/** `adr x19, table; L1: bl helper; cmp w0, #2; b.hi out; mov w8, w0; adr x10, cases;
 * ldrb w11, [x19, x8]; add x10, x10, x11, lsl #2; br x10`, where case 2 branches back to L1.
 * The table base lives in callee-saved x19, set once before the loop. The chain starts after
 * the call, so only a fact on x19 that survives `bl` proves the table. */
const CALL_LOOP = [
  0x10000273, // 0x1000 adr x19, 0x104c (table)
  0x94000010, // 0x1004 L1: bl 0x1044 (helper)
  0x7100081f, // 0x1008 cmp w0, #2
  0x54000188, // 0x100c b.hi 0x103c
  0x2a0003e8, // 0x1010 mov w8, w0
  0x1000008a, // 0x1014 adr x10, 0x1024
  0x38686a6b, // 0x1018 ldrb w11, [x19, x8]
  0x8b0b094a, // 0x101c add x10, x10, x11, lsl #2
  0xd61f0140, // 0x1020 br x10
  0xd2800020, // 0x1024 mov x0, #1
  0xd65f03c0, // 0x1028 ret
  0xd2800040, // 0x102c mov x0, #2
  0xd65f03c0, // 0x1030 ret
  0x17fffff4, // 0x1034 b 0x1004 (L1)
  NOP, // 0x1038
  0xd2800120, // 0x103c mov x0, #9
  0xd65f03c0, // 0x1040 ret
  0xd2800000, // 0x1044 helper: mov x0, #0
  0xd65f03c0, // 0x1048 ret
];
/** CALL_LOOP whose case 2 runs `instruction` before branching back to L1. */
const callLoopWith = (instruction: number) => {
  const words = [...CALL_LOOP];
  words.splice(13, 2, instruction, 0x17fffff3); // 0x1034 instruction; 0x1038 b 0x1004
  return words;
};

const addressOf = (graph: FunctionGraph, id: string) =>
  graph.instructions.find((instruction) => instruction.id === id)!.address.value;

test('a callee-saved table base set before a loop with a call resolves under the ABI', () => {
  const loaded = image({ words: CALL_LOOP });
  for (const result of [
    discover(loaded, [], { abi: true }),
    discoverSelected(loaded, { abi: true }),
  ]) {
    const graph = root(result);
    assert.equal(graph.jump_tables?.length, 1);
    const table = graph.jump_tables![0]!;
    assert.equal(table.table.start.value, 0x104cn);
    assert.deepEqual(
      table.targets.map((target) => target.value),
      [0x1024n, 0x102cn, 0x1034n],
    );
    assert.equal(table.otherwise.value, 0x103cn);
    // The fact holds on the entry path and on case 2's loop edge, across the call on both.
    assert.deepEqual(
      table.entry_facts?.map((fact) => ({
        register: fact.register,
        value: fact.value,
        definitions: fact.definitions.map((id) => addressOf(graph, id)),
        calls: fact.calls.map((id) => addressOf(graph, id)),
      })),
      [
        {
          register: 'arm64:x19',
          value: { kind: 'const', value: 0x104cn },
          definitions: [0x1000n],
          calls: [0x1004n],
        },
      ],
    );
    assert.equal(graph.coverage.state, 'complete');
    assert.ok(members(graph).has(0x1034n));
    const evidence = result.evidence.find((item) => item.id === table.evidence_ids[0]);
    assert.match(evidence?.claim ?? '', /darwin-arm64 ABI preserves/);
  }
});

test('a table base redefined on one loop edge stays unresolved', () => {
  // Case 2 adds 1 to x19 before looping: the base differs between L1's two predecessors.
  const loaded = image({ words: callLoopWith(0x91000673) }); // add x19, x19, #1
  for (const result of [
    discover(loaded, [], { abi: true }),
    discoverSelected(loaded, { abi: true }),
  ]) {
    const graph = root(result);
    assert.equal(graph.jump_tables, undefined);
    assert.ok(graph.coverage.reasons.includes('unresolved control flow'));
    for (const address of [0x1024n, 0x102cn, 0x1034n])
      assert.ok(!members(graph).has(address), `0x${address.toString(16)} is no member`);
  }
});

test('without the ABI preserved registers a call forgets the table base', () => {
  const loaded = image({ words: CALL_LOOP });
  for (const result of [discover(loaded), discoverSelected(loaded)]) {
    const graph = root(result);
    assert.equal(graph.jump_tables, undefined);
    assert.ok(graph.coverage.reasons.includes('unresolved control flow'));
  }
});

/** `ldr w8, [x0]; cbz x1, L1; nop; L1: cmp w8, #2; b.hi out; adr x9, table; adr x10, cases;
 * ldrb w11, [x9, x8]; add x10, x10, x11, lsl #2; br x10`. The guard reads w8, the load
 * indexes with all of x8, and the chain starts at the join L1. */
const JOINED_INDEX = [
  0xb9400008, // 0x1000 ldr w8, [x0]
  0xb4000041, // 0x1004 cbz x1, 0x100c
  NOP, // 0x1008
  0x7100091f, // 0x100c L1: cmp w8, #2
  0x54000188, // 0x1010 b.hi 0x1040
  0x100001a9, // 0x1014 adr x9, 0x1048 (table)
  0x1000008a, // 0x1018 adr x10, 0x1028
  0x3868692b, // 0x101c ldrb w11, [x9, x8]
  0x8b0b094a, // 0x1020 add x10, x10, x11, lsl #2
  0xd61f0140, // 0x1024 br x10
  0xd2800020, // 0x1028 mov x0, #1
  0xd65f03c0, // 0x102c ret
  0xd2800040, // 0x1030 mov x0, #2
  0xd65f03c0, // 0x1034 ret
  0xd2800060, // 0x1038 mov x0, #3
  0xd65f03c0, // 0x103c ret
  0xd2800120, // 0x1040 mov x0, #9
  0xd65f03c0, // 0x1044 ret
];

test('a w-guarded index loaded through x resolves only when its definition zero-extends', () => {
  const loaded = image({ words: JOINED_INDEX });
  for (const result of [discover(loaded), discoverSelected(loaded)]) {
    const graph = root(result);
    assert.equal(graph.jump_tables?.length, 1);
    const table = graph.jump_tables![0]!;
    assert.deepEqual(
      table.targets.map((target) => target.value),
      [0x1028n, 0x1030n, 0x1038n],
    );
    assert.equal(table.guard_exact, true);
    assert.deepEqual(
      table.entry_facts?.map((fact) => [
        fact.register,
        fact.value,
        fact.definitions.map((id) => addressOf(graph, id)),
      ]),
      [['arm64:x8', { kind: 'zext', bits: 32 }, [0x1000n]]],
    );
  }
  // A 64-bit load leaves the upper half of x8 unknown: the w8 guard does not bound x8.
  const words = [...JOINED_INDEX];
  words[0] = 0xf9400008; // ldr x8, [x0]
  for (const result of [discover(image({ words })), discoverSelected(image({ words }))])
    assert.equal(root(result).jump_tables, undefined);
});

test('a hoisted x86 `lea r14, [rip + table]` base resolves across a call under SysV', () => {
  // lea r14, [rip+table]; L1: call helper; mov ecx, eax; cmp ecx, 2; ja out;
  // movsxd rax, [r14 + rcx*4]; add rax, r14; jmp rax; case 2 jumps back to L1.
  const x86 = [
    0x4c,
    0x8d,
    0x35,
    0x2c,
    0x00,
    0x00,
    0x00, // 0x1000 lea r14, [rip + 0x2c] (0x1033)
    0xe8,
    0x24,
    0x00,
    0x00,
    0x00, // 0x1007 L1: call 0x1030
    0x89,
    0xc1, // 0x100c mov ecx, eax
    0x83,
    0xf9,
    0x02, // 0x100e cmp ecx, 2
    0x77,
    0x17, // 0x1011 ja 0x102a
    0x49,
    0x63,
    0x04,
    0x8e, // 0x1013 movsxd rax, dword [r14 + rcx*4]
    0x4c,
    0x01,
    0xf0, // 0x1017 add rax, r14
    0xff,
    0xe0, // 0x101a jmp rax
    0xb8,
    0x01,
    0x00,
    0x00,
    0x00,
    0xc3, // 0x101c mov eax, 1; ret
    0xb8,
    0x02,
    0x00,
    0x00,
    0x00,
    0xc3, // 0x1022 mov eax, 2; ret
    0xeb,
    0xdd, // 0x1028 jmp 0x1007
    0xb8,
    0x09,
    0x00,
    0x00,
    0x00,
    0xc3, // 0x102a mov eax, 9; ret
    0x31,
    0xc0,
    0xc3, // 0x1030 helper: xor eax, eax; ret
  ];
  // Signed offsets from the table (0x1033) to 0x101c, 0x1022 and 0x1028.
  const table = [0xe9, 0xff, 0xff, 0xff, 0xef, 0xff, 0xff, 0xff, 0xf5, 0xff, 0xff, 0xff];
  const loaded = image({ x86, table });
  for (const result of [
    discover(loaded, [], { abi: true }),
    discoverSelected(loaded, { abi: true }),
  ]) {
    const graph = root(result);
    assert.equal(graph.jump_tables?.length, 1);
    const resolved = graph.jump_tables![0]!;
    assert.deepEqual(
      resolved.targets.map((target) => target.value),
      [0x101cn, 0x1022n, 0x1028n],
    );
    assert.deepEqual(resolved.entry, { bytes: 4, signed: true, stride: 4 });
    assert.deepEqual(
      resolved.entry_facts?.map((fact) => [
        fact.register,
        fact.value,
        fact.definitions.map((id) => addressOf(graph, id)),
        fact.calls.map((id) => addressOf(graph, id)),
      ]),
      [['x86_64:r14', { kind: 'const', value: 0x1033n }, [0x1000n], [0x1007n]]],
    );
    assert.equal(graph.coverage.state, 'complete');
  }
  assert.equal(root(discover(loaded)).jump_tables, undefined);
});

test('pointer authentication or a supervisor call in the loop forgets every fact', () => {
  // paciasp writes x30 and svc any register, neither through an operand; a nop keeps the fact.
  const control = image({ words: callLoopWith(NOP), features: ['FEAT_PAuth'] });
  assert.equal(root(discover(control, [], { abi: true })).jump_tables?.length, 1);
  for (const instruction of [0xd503233f, 0xd4000001]) {
    const loaded = image({ words: callLoopWith(instruction), features: ['FEAT_PAuth'] });
    for (const result of [
      discover(loaded, [], { abi: true }),
      discoverSelected(loaded, { abi: true }),
    ])
      assert.equal(root(result).jump_tables, undefined);
  }
});
