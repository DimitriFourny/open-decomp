import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import {
  AddressMap,
  ImmutableBytes,
  OperationError,
  contentHash,
  createOperationContext,
  imageIdentity,
  sliceIdentity,
  fingerprint,
  type Address,
  type AddressRange,
  type Decoder,
  type Evidence,
  type FunctionGraph,
  type LoadedImage,
  type Loader,
} from '../../src/core/index.js';
import { Arm64Decoder } from '../../src/decoders/arm64/index.js';
import { X86Decoder } from '../../src/decoders/x86_64/index.js';
import { MachOLoader } from '../../src/loaders/macho/index.js';
import { PELoader } from '../../src/loaders/pe/index.js';
import { Arm64Lifter } from '../../src/lifters/arm64/index.js';
import { DarwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import {
  discoverFunctions,
  prepareDiscoveryIndex,
  type DiscoveryInput,
  type FunctionAssertion,
} from '../../src/analysis/discovery/index.js';

function load(path: string, loader: Loader): LoadedImage {
  const bytes = readFileSync(path);
  const sha256 = contentHash(bytes);
  return loader.load(
    { bytes: new ImmutableBytes(bytes), image_id: imageIdentity(sha256), sha256, slice_id: null },
    createOperationContext(),
  );
}
function raw(bytes: readonly number[], architecture: 'x86_64' | 'arm64' = 'x86_64'): LoadedImage {
  const buffer = Uint8Array.from(bytes);
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
    target:
      architecture === 'x86_64'
        ? {
            format: 'pe',
            architecture,
            abi: 'windows-x64',
            endian: 'little',
            address_bits: 64,
            features: [],
          }
        : {
            format: 'macho',
            architecture,
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
    entry_points: [{ image_id: id, space: 'va', value: 0x1000n }],
    hints: [],
    headers: [],
    sections: [],
    symbols: [],
    imports: [],
    exports: [],
    relocations: [],
    evidence: [],
    diagnostics: [],
    capabilities: [],
  };
}
function address(image: LoadedImage, offset: number): Address {
  return { image_id: image.id, space: 'va', value: image.image_base + BigInt(offset) };
}
function assertion(
  image: LoadedImage,
  offset: number,
  status: 'asserted' | 'retracted' = 'asserted',
  ranges?: readonly AddressRange[],
): FunctionAssertion {
  const evidence: Evidence = {
    id: `evidence_${fingerprint(['test-assertion', offset, status])}`,
    origin: { kind: 'assertion', author: 'test', agent: 'user', status },
    claim: 'Function entry',
    derived_from: [],
    conflicts_with: [],
    revision: 1,
  };
  return { entry: address(image, offset), evidence, ...(ranges ? { ranges } : {}) };
}
function discover(
  image: LoadedImage,
  options: Partial<Omit<DiscoveryInput, 'image' | 'decoder'>> = {},
  budget = {},
) {
  const decoder =
    image.target.architecture === 'arm64'
      ? new Arm64Decoder()
      : new X86Decoder({ formatting: false });
  try {
    return discoverFunctions(
      { image, decoder, revision: 0, ...options },
      createOperationContext({ budget }),
    );
  } finally {
    decoder.dispose();
  }
}

for (const name of [
  'macho-arm64-symbols',
  'macho-arm64-stripped',
  'libcorpus-arm64-symbols.dylib',
  'libcorpus-arm64-stripped.dylib',
  'corpus-symbols.dll',
  'corpus-stripped.dll',
  'pe-x86_64-symbols.exe',
  'pe-x86_64-stripped.exe',
]) {
  test(`actual loader/decoder discovery: ${name}`, () => {
    const arm = name.includes('arm64');
    const image = load(`fixtures/bin/${name}`, arm ? new MachOLoader() : new PELoader());
    const result = discover(image);
    assert.ok(
      result.references.some(
        (reference) => reference.kind === 'call' || reference.kind === 'tail_call',
      ),
    );
    for (const graph of result.graphs) {
      assert.equal(graph.slice_id, image.selected_slice_id);
      assert.ok(graph.blocks.every((block) => block.edges.every((edge) => edge.kind !== 'call')));
      const blockIds = new Set(graph.blocks.map((block) => block.id));
      for (const block of graph.blocks)
        for (const edge of block.edges) if (edge.to !== null) assert.ok(blockIds.has(edge.to));
    }
    if (name === 'macho-arm64-symbols' || name.startsWith('corpus-')) {
      // Addresses and control flow independently recorded by LLVM in fixtures/metadata.
      const arithmetic = result.graphs.find(
        (graph) => graph.function.entry.value === (arm ? 0x100000574n : 0x180001030n),
      );
      assert.ok(arithmetic);
      assert.equal(arithmetic.instructions.at(-1)?.flow.kind, 'return');
      assert.equal(arithmetic.instructions.length, arm ? 5 : 4);
      const loop = result.graphs.find(
        (graph) => graph.function.entry.value === (arm ? 0x100000594n : 0x180001050n),
      );
      assert.ok(
        loop?.blocks.some((block) =>
          block.edges.some(
            (edge) =>
              edge.kind === 'branch' &&
              edge.target &&
              edge.target.value <= block.ranges[0]!.start.value,
          ),
        ),
      );
      const direct = result.references.find(
        (reference) =>
          reference.kind === 'call' && reference.from.value === (arm ? 0x1000005e4n : 0x18000108bn),
      );
      if (arm) assert.equal(direct?.to?.value, 0x100000548n);
      assert.ok(result.references.some((reference) => reference.status === 'unresolved'));
    }
  });
}

for (const file of ['macho-arm64-symbols', 'macho-arm64-stripped'])
  test(`declared constants in executable Mach-O segments are not functions: ${file}`, () => {
    const image = load(`fixtures/bin/${file}`, new MachOLoader());
    const constant = image.sections.find(
      (item) => item.kind === 'section' && item.name === '__const',
    )?.virtual_range;
    assert.ok(constant);
    const result = discover(image),
      end = constant.start.value + constant.size;
    assert.ok(
      !result.graphs.some(
        (graph) =>
          graph.function.entry.value >= constant.start.value && graph.function.entry.value < end,
      ),
    );
    assert.ok(
      !result.graphs.some((graph) =>
        graph.instructions.some(
          (instruction) =>
            instruction.address.value >= constant.start.value && instruction.address.value < end,
        ),
      ),
    );
    const backing = image.address_map.translate(constant.start, 'file');
    assert.equal(backing.kind, 'mapped');
    assert.equal(image.bytes.at(Number(backing.address.value)), 0x6f); // 'o', not an instruction seed.
  });

test('zero-sized object symbols defeat export-only code guesses without overriding explicit assertions', () => {
  // ret; nop; int3 — the object symbol names the nop; fill is never a function.
  const image = raw([0xc3, 0x90, 0xcc]),
    target = address(image, 1);
  const named = {
    id: `entity_${fingerprint('object-symbol')}`,
    original_name: 'data_bytes',
    display_name: null,
    evidence_ids: [],
  };
  const withObject: LoadedImage = {
    ...image,
    symbols: [{ ...named, kind: 'object', address: target, size: null, binding: 'global' }],
    exports: [
      {
        ...named,
        id: `entity_${fingerprint('object-export')}`,
        address: target,
        ordinal: null,
        forwarder: null,
      },
    ],
  };
  assert.deepEqual(
    discover(withObject).graphs.map((graph) => graph.function.entry.value),
    [0x1000n],
  );
  assert.ok(
    discover(withObject, { assertions: [assertion(withObject, 1)] }).graphs.some(
      (graph) => graph.function.entry.value === target.value,
    ),
  );
});

test('recursive calls are references, loop targets split blocks, dead bytes are not swept', () => {
  // call +8; test eax,eax; jne test; ret; dead int3; callee ret
  const image = raw([0xe8, 8, 0, 0, 0, 0x85, 0xc0, 0x75, 0xfc, 0xc3, 0xcc, 0xcc, 0xcc, 0xc3]);
  const result = discover(image);
  assert.deepEqual(
    result.graphs.map((graph) => graph.function.entry.value),
    [0x1000n, 0x100dn],
  );
  const caller = result.graphs[0]!;
  assert.deepEqual(
    caller.instructions.map((instruction) => instruction.address.value),
    [0x1000n, 0x1005n, 0x1007n, 0x1009n],
  );
  assert.equal(caller.blocks.length, 3);
  const loop = caller.blocks.find((block) => block.ranges[0]!.start.value === 0x1005n)!;
  assert.ok(loop.edges.some((edge) => edge.to === loop.id));
  assert.equal(
    result.references.find((reference) => reference.kind === 'call')?.to_entity,
    result.graphs[1]!.function.id,
  );
  assert.ok(
    caller.blocks.every((block) =>
      block.edges.every((edge) => edge.to !== result.graphs[1]!.blocks[0]!.id),
    ),
  );
});

test('ARM direct calls and loops use real fixed-width decoding', () => {
  const words = [0x94000004, 0x71000400, 0x54ffffe1, 0xd65f03c0, 0xd65f03c0]; // bl +16; subs w0,w0,#1; b.ne -4; ret; ret
  const bytes = Buffer.alloc(words.length * 4);
  words.forEach((word, i) => bytes.writeUInt32LE(word, i * 4));
  const result = discover(raw([...bytes], 'arm64'));
  assert.equal(result.graphs.length, 2);
  assert.equal(
    result.references.find((reference) => reference.kind === 'call')?.to?.value,
    0x1010n,
  );
  assert.ok(
    result.graphs[0]!.blocks.some((block) => block.edges.some((edge) => edge.to === block.id)),
  );
});

test('bounded ARM navigation retains every loader root and call without repeatedly preparing image hints', () => {
  const count = 512;
  const bytes = Buffer.alloc(count * 8);
  for (let i = 0; i < count; i++) {
    bytes.writeUInt32LE(i + 1 < count ? 0x94000002 : 0xd65f03c0, i * 8); // bl next function / ret
    bytes.writeUInt32LE(0xd65f03c0, i * 8 + 4);
  }
  const base = raw([...bytes], 'arm64');
  const data = address(base, bytes.length - 4);
  const image: LoadedImage = {
    ...base,
    hints: [
      ...Array.from({ length: count }, (_, i) => ({
        kind: 'function' as const,
        address: address(base, i * 8),
        size: null,
        evidence_ids: [],
      })),
      {
        kind: 'data',
        range: { start: data, size: 4n },
        encoding: 'literal_pool',
        evidence_ids: [],
      },
    ],
  };
  const result = discover(image, {}, { work: 200_000, instructions: 2_000, blocks: 2_000 });
  assert.equal(result.coverage.state, 'complete');
  assert.equal(result.graphs.length, count);
  assert.ok(
    result.graphs.every(
      (graph) => graph.function.boundary === 'established' && graph.coverage.state === 'complete',
    ),
  );
  assert.ok(
    result.graphs.every((graph) =>
      graph.instructions.every((instruction) => instruction.address.value < data.value),
    ),
  );
  const calls = result.references.filter((reference) => reference.kind === 'call');
  assert.equal(calls.length, count - 1);
  for (let i = 0; i < calls.length; i++) {
    assert.equal(calls[i]!.from_function, result.graphs[i]!.function.id);
    assert.equal(calls[i]!.to_entity, result.graphs[i + 1]!.function.id);
    assert.equal(calls[i]!.to?.value, result.graphs[i + 1]!.function.entry.value);
    assert.equal(calls[i]!.status, 'established');
    assert.ok(calls[i]!.evidence_ids.every((id) => result.evidence.some((item) => item.id === id)));
  }
  const conflict = discover(
    image,
    { assertions: [assertion(image, bytes.length - 4)] },
    { work: 200_000, instructions: 2_000, blocks: 2_000 },
  );
  const blocked = conflict.graphs.find((graph) => graph.function.entry.value === data.value)!;
  assert.equal(conflict.coverage.state, 'partial');
  assert.equal(blocked.function.boundary, 'conflicting');
  assert.deepEqual(blocked.instructions, []);
  assert.equal(blocked.gaps[0]?.reason, 'data');
  assert.deepEqual(
    conflict.graphs.slice(0, count).map((graph) => graph.function.id),
    result.graphs.map((graph) => graph.function.id),
  );
});

test('bounded x86 navigation preserves roots, calls, claimed data and identities with many boundaries', () => {
  const count = 512;
  const bytes = Buffer.alloc(count * 8, 0xcc);
  for (let i = 0; i < count; i++) {
    if (i + 1 < count)
      bytes.set([0xe8, 3, 0, 0, 0, 0xc3], i * 8); // call next function; ret
    else bytes[i * 8] = 0xc3;
  }
  const base = raw([...bytes]);
  const source: Evidence = {
    id: `evidence_${fingerprint('many-native-boundaries')}`,
    origin: {
      kind: 'binary',
      range: { start: address(base, 0), size: BigInt(bytes.length) },
      description: 'Native function and data boundaries',
    },
    claim: 'Function extents contain trailing data, not reachable code',
    derived_from: [],
    conflicts_with: [],
    revision: 0,
  };
  const image: LoadedImage = {
    ...base,
    evidence: [source],
    hints: [
      ...Array.from({ length: count }, (_, i) => ({
        kind: 'function' as const,
        address: address(base, i * 8),
        size: 8n,
        evidence_ids: [source.id],
      })),
      ...Array.from({ length: count }, (_, i) => ({
        kind: 'data' as const,
        range: { start: address(base, (count - i - 1) * 8 + 6), size: 2n },
        encoding: 'bytes' as const,
        evidence_ids: [source.id],
      })),
    ],
  };
  const budget = { work: 200_000, instructions: 2_000, blocks: 2_000 };
  const result = discover(image, {}, budget);
  assert.equal(result.coverage.state, 'complete');
  assert.equal(result.graphs.length, count);
  assert.equal(result.boundary_claims.length, count);
  assert.equal(result.references.length, count - 1);
  for (let i = 0; i < count; i++) {
    const graph = result.graphs[i]!;
    assert.equal(graph.function.entry.value, address(image, i * 8).value);
    assert.equal(graph.function.boundary, 'established');
    assert.equal(graph.coverage.state, 'complete');
    assert.deepEqual(
      graph.instructions.map((instruction) => instruction.address.value),
      (i + 1 < count ? [i * 8, i * 8 + 5] : [i * 8]).map((offset) => address(image, offset).value),
    );
    assert.deepEqual(
      graph.gaps.map((gap) => [gap.reason, gap.range.start.value, gap.range.size]),
      [['data', address(image, i * 8 + 6).value, 2n]],
    );
    const claim = result.boundary_claims[i]!;
    assert.equal(claim.range.size, 8n);
    assert.ok(
      claim.evidence_ids.every((id) =>
        result.evidence.find((item) => item.id === id)?.derived_from.includes(source.id),
      ),
    );
    if (i + 1 < count) {
      const call = result.references[i]!;
      assert.equal(call.kind, 'call');
      assert.equal(call.from_function, graph.function.id);
      assert.equal(call.to_entity, result.graphs[i + 1]!.function.id);
      assert.equal(call.to?.value, address(image, (i + 1) * 8).value);
      assert.ok(call.evidence_ids.length > 0);
      assert.ok(call.evidence_ids.every((id) => result.evidence.some((item) => item.id === id)));
    }
  }
  assert.deepEqual(result, discover(image, {}, { ...budget, work: 2_000_000 }));
  const atData = bytes.length - 2;
  const conflict = discover(image, { assertions: [assertion(image, atData)] }, budget);
  const blocked = conflict.graphs.find(
    (graph) => graph.function.entry.value === address(image, atData).value,
  )!;
  assert.equal(blocked.function.boundary, 'conflicting');
  assert.deepEqual(blocked.instructions, []);
  assert.deepEqual(blocked.gaps[0]!.diagnostics[0]!.evidence_ids, [source.id]);
  assert.deepEqual(
    conflict.graphs.slice(0, count).map((graph) => graph.function.id),
    result.graphs.map((graph) => graph.function.id),
  );
});

test('nested data boundaries retain the first containing claim and zero-sized hints do not truncate code', () => {
  const base = raw([
    0xeb, 10, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xc3, 0xcc, 0xc3,
  ]);
  const outer = assertion(base, 4).evidence,
    inner = assertion(base, 6).evidence;
  const image: LoadedImage = {
    ...base,
    evidence: [outer, inner],
    hints: [
      {
        kind: 'data',
        range: { start: address(base, 6), size: 2n },
        encoding: 'bytes',
        evidence_ids: [inner.id],
      },
      {
        kind: 'data',
        range: { start: address(base, 4), size: 10n },
        encoding: 'bytes',
        evidence_ids: [outer.id],
      },
      {
        kind: 'data',
        range: { start: address(base, 1), size: 0n },
        encoding: 'bytes',
        evidence_ids: [],
      },
    ],
    exports: [
      {
        id: `entity_${fingerprint('nested-data-export')}`,
        address: address(base, 12),
        original_name: 'not_code',
        display_name: null,
        evidence_ids: [],
        ordinal: null,
        forwarder: null,
      },
    ],
  };
  const result = discover(image, { assertions: [assertion(image, 14)] });
  assert.deepEqual(
    result.graphs.map((graph) => graph.function.entry.value),
    [0x1000n, 0x100en],
  );
  const first = result.graphs[0]!;
  assert.equal(first.instructions[0]!.size, 2);
  assert.equal(first.instructions[0]!.flow.kind, 'branch');
  assert.equal(first.gaps[0]!.range.start.value, 0x100cn);
  assert.equal(first.gaps[0]!.range.size, 2n);
  assert.deepEqual(first.gaps[0]!.diagnostics[0]!.evidence_ids, [outer.id]);
  assert.equal(result.graphs[1]!.instructions[0]!.flow.kind, 'return');
});

test('decode lookahead cannot cross data, non-executable backing, holes or zero-fill', () => {
  const base = raw([0xe8, 0, 0, 0, 0, 0xc3]);
  const withData: LoadedImage = {
    ...base,
    hints: [
      {
        kind: 'data',
        range: { start: address(base, 4), size: 1n },
        encoding: 'bytes',
        evidence_ids: [],
      },
    ],
  };
  for (const image of [
    withData,
    ...['non-executable', 'hole', 'zero-fill'].map((kind) => {
      const mappings = [
        {
          id: 'first',
          va: 0x1000n,
          file_offset: 0n,
          file_size: 4n,
          memory_size: kind === 'zero-fill' ? 6n : 4n,
          permissions: ['read', 'execute'] as const,
        },
        ...(kind === 'non-executable'
          ? [
              {
                id: 'second',
                va: 0x1004n,
                file_offset: 4n,
                file_size: 2n,
                memory_size: 2n,
                permissions: ['read'] as const,
              },
            ]
          : []),
      ];
      return {
        ...base,
        mappings,
        address_map: new AddressMap({
          image_id: base.id,
          image_base: base.image_base,
          byte_length: 6n,
          slice_offset: 0n,
          slice_size: 6n,
          mappings,
        }),
      };
    }),
  ]) {
    const result = discover(image);
    assert.deepEqual(result.graphs[0]!.instructions, []);
    assert.equal(result.graphs[0]!.gaps[0]!.reason, 'truncated');
    assert.equal(result.references.length, 0);
    assert.equal(result.coverage.state, 'partial');
  }
});

test('decoder work remains cumulative with work already consumed by its caller', () => {
  const image = raw([0xc3]);
  const native = new X86Decoder({ formatting: false });
  const decoder: Decoder = {
    name: native.name,
    version: native.version,
    architecture: native.architecture,
    decode(request, context) {
      // An individually affordable decoder charge must still fail against work
      // already spent by the caller, rather than a fresh per-window operation.
      context.checkpoint(20_000);
      return native.decode(request, context);
    },
    dispose() {
      native.dispose();
    },
  };
  try {
    const spent = createOperationContext({ budget: { work: 100_000 } });
    spent.checkpoint(90_000);
    assert.throws(
      () => discoverFunctions({ image, decoder, revision: 0 }, spent),
      (error: unknown) => error instanceof OperationError && error.code === 'resource_limit',
    );
  } finally {
    decoder.dispose();
  }
});

test('noncontiguous regions, file-coordinate data, and reachable data conflicts remain explicit', () => {
  const base = raw([0xeb, 4, 0xff, 0xff, 0xff, 0xff, 0xc3]);
  const image: LoadedImage = {
    ...base,
    hints: [
      { kind: 'function', address: address(base, 0), size: 7n, evidence_ids: [] },
      {
        kind: 'data',
        range: { start: { ...address(base, 0), space: 'file', value: 2n }, size: 4n },
        encoding: 'jump_table',
        evidence_ids: [],
      },
    ],
  };
  const result = discover(image);
  assert.deepEqual(
    result.graphs[0]!.function.ranges.map((range) => [range.start.value, range.size]),
    [
      [0x1000n, 2n],
      [0x1006n, 1n],
    ],
  );
  assert.ok(result.graphs[0]!.gaps.some((gap) => gap.reason === 'data' && gap.range.size === 4n));
  assert.equal(result.jump_tables[0]!.status, 'candidate');
  const conflict = discover(image, { assertions: [assertion(image, 2)] }).graphs.find(
    (graph) => graph.function.entry.value === 0x1002n,
  )!;
  assert.equal(conflict.function.boundary, 'conflicting');
  assert.equal(conflict.instructions.length, 0);
});

test('unknown indirects and indexed jump-table candidates do not invent target edges', () => {
  const image = raw([0xff, 0x24, 0xc5, 0x10, 0x10, 0, 0]); // jmp qword ptr [rax*8+0x1010]
  const result = discover(image);
  assert.equal(result.graphs[0]!.coverage.state, 'partial');
  assert.equal(result.graphs[0]!.blocks[0]!.edges[0]!.kind, 'unknown');
  assert.equal(result.graphs[0]!.blocks[0]!.edges[0]!.to, null);
  assert.equal(result.references[0]!.status, 'unresolved');
  assert.equal(result.jump_tables[0]!.address.value, 0x1010n);
  assert.equal(result.jump_tables[0]!.range, null);
});

test('shared tails preserve multiple owners; distinct entries are tail-call exits', () => {
  // two entry branches to a shared ret at +8
  const base = raw([0xeb, 6, 0xcc, 0xcc, 0xeb, 2, 0xcc, 0xcc, 0xc3]);
  const result = discover(base, { assertions: [assertion(base, 4)] });
  assert.equal(result.graphs.length, 2);
  const shared = result.overlaps.find((overlap) => overlap.kind === 'shared_tail');
  assert.equal(shared?.range.start.value, 0x1008n);
  assert.equal(shared?.function_ids.length, 2);
  const tails = discover(base, { assertions: [assertion(base, 4), assertion(base, 8)] });
  assert.equal(tails.references.filter((reference) => reference.kind === 'tail_call').length, 2);
  assert.ok(
    tails.graphs
      .slice(0, 2)
      .every(
        (graph) =>
          graph.blocks[0]!.edges[0]!.kind === 'tail_call' && graph.blocks[0]!.edges[0]!.to === null,
      ),
  );
});

test('overlapping instruction streams and fallthrough boundary conflicts are not suppressed', () => {
  const image = raw([0xb8, 0x90, 0x90, 0x90, 0x90, 0xc3]);
  const result = discover(image, { assertions: [assertion(image, 1)] });
  assert.ok(result.overlaps.some((overlap) => overlap.kind === 'overlapping_instructions'));
  assert.ok(result.graphs.every((graph) => graph.function.boundary === 'conflicting'));
  const fallthrough = raw([0x90, 0xc3]);
  assert.equal(
    discover(fallthrough, { assertions: [assertion(fallthrough, 1)] }).graphs[0]!.function.boundary,
    'conflicting',
  );
});
test('a final call to a declared noreturn callee ends flow before the next function entry', () => {
  // f: bl stub (its return address is g's entry, like a final `bl ___stack_chk_fail`);
  // g: ret; stub: ret
  const words = [0x94000002, 0xd65f03c0, 0xd65f03c0];
  const bytes = Buffer.alloc(words.length * 4);
  words.forEach((word, i) => bytes.writeUInt32LE(word, i * 4));
  const image = raw([...bytes], 'arm64');
  const assertions = [assertion(image, 4)];
  const declared = new Map([[0x1008n, ['evidence_import_binding']]]);
  for (const noreturn of [false, true]) {
    const result = discover(image, {
      assertions,
      ...(noreturn ? { noreturn_calls: declared } : {}),
    });
    const caller = result.graphs.find((graph) => graph.function.entry.value === 0x1000n)!;
    assert.equal(caller.function.boundary, noreturn ? 'established' : 'conflicting');
    assert.equal(
      caller.diagnostics.some(
        (item) => item.message === 'Intraprocedural flow reaches another function entry',
      ),
      !noreturn,
    );
    assert.deepEqual(
      caller.instructions.map((instruction) => instruction.address.value),
      [0x1000n],
    );
    const edges = caller.blocks.flatMap((block) => block.edges);
    assert.deepEqual(
      edges.map((edge) => edge.kind),
      [noreturn ? 'trap' : 'fallthrough'],
    );
    const lifted = new Arm64Lifter().lift(caller, new DarwinArm64Abi(), createOperationContext());
    const exit = lifted.ir.blocks.find((block) =>
      block.instructions.some((node) => node.kind === 'call'),
    )!;
    assert.equal(exit.terminator.kind, noreturn ? 'trap' : 'unknown');
    if (noreturn) {
      // The proof cites the declaration's evidence and is published with the graph.
      const proof = result.evidence.find(
        (item) =>
          edges[0]!.evidence_ids.includes(item.id) &&
          item.derived_from.includes('evidence_import_binding'),
      );
      assert.ok(proof);
    }
  }
});

test("selected discovery publishes every proof its diagnostics cite, including another root's seed proofs", () => {
  // A (entry, +0): jz +4 -> B (+4, asserted root). Conditional flow into a foreign
  // root is a boundary conflict whose diagnostic cites B's seed proof, not A's.
  const image = raw([0x74, 0x02, 0x90, 0xc3, 0xc3]);
  const decoder = new X86Decoder({ formatting: false });
  try {
    const context = createOperationContext();
    const input = { image, decoder, revision: 0, assertions: [assertion(image, 4)] };
    const index = prepareDiscoveryIndex(input, context);
    const result = discoverFunctions(
      { ...input, index, selected_entry: address(image, 0) },
      context,
    );
    const conflict = result.graphs[0]!.diagnostics.find(
      (item) => item.message === 'Intraprocedural flow reaches another function entry',
    );
    assert.ok(conflict, 'fixture must reach another function entry');
    const foreign = [...index.seeds.get(0x1004n)!.evidence];
    assert.ok(foreign.length > 0);
    const published = new Map(result.evidence.map((item) => [item.id, item]));
    const closed = new Set<string>();
    const pending = [
      ...result.graphs[0]!.function.evidence_ids,
      ...result.graphs.flatMap((graph) => graph.diagnostics.flatMap((item) => item.evidence_ids)),
    ];
    for (const id of pending) {
      if (closed.has(id)) continue;
      closed.add(id);
      const proof = published.get(id);
      assert.ok(proof, `cited proof ${id} must be published with the selected discovery`);
      pending.push(...proof.derived_from, ...proof.conflicts_with);
    }
    for (const id of foreign) assert.ok(published.has(id));
  } finally {
    decoder.dispose();
  }
});

test('invalid encodings, truncation and unbacked direct targets stop without synthetic traps', () => {
  for (const bytes of [[0x0f], [0x0f, 0xff], [0xe9, 0xff, 0, 0, 0]]) {
    const result = discover(raw(bytes));
    assert.equal(result.graphs[0]!.coverage.state, 'partial');
    assert.ok(
      result.graphs[0]!.blocks.every((block) => block.edges.every((edge) => edge.kind !== 'trap')),
    );
  }
});

test('renames preserve IDs, actual splits and merges mint lineage and never reuse old IDs', () => {
  const image = raw([0xeb, 2, 0xcc, 0xcc, 0xc3]);
  const original = discover(image);
  const renamed = discover(
    {
      ...image,
      symbols: [
        {
          id: `entity_${fingerprint('name')}`,
          kind: 'function',
          address: address(image, 0),
          size: null,
          original_name: 'renamed',
          display_name: 'renamed',
          binding: 'global',
          evidence_ids: [],
        },
      ],
    },
    { previous: original.graphs, revision: 1 },
  );
  assert.equal(renamed.graphs[0]!.function.id, original.graphs[0]!.function.id);
  assert.deepEqual(renamed.lineage, []);
  const split = discover(image, {
    previous: original.graphs,
    assertions: [assertion(image, 4)],
    revision: 1,
  });
  const lineage = split.lineage.find((item) => item.reason === 'split');
  assert.deepEqual(lineage?.previous, [original.graphs[0]!.function.id]);
  assert.deepEqual(new Set(lineage?.next), new Set(split.graphs.map((graph) => graph.function.id)));
  assert.ok(split.graphs.every((graph) => graph.function.id !== original.graphs[0]!.function.id));
  const stable = discover(image, {
    previous: split.graphs,
    assertions: [assertion(image, 4)],
    revision: 2,
  });
  assert.deepEqual(
    stable.graphs.map((graph) => graph.function.id),
    split.graphs.map((graph) => graph.function.id),
  );
  assert.deepEqual(stable.lineage, []);
  const merge = discover(image, { previous: split.graphs, revision: 2 });
  assert.equal(
    merge.lineage.find((item) => item.reason === 'merge')?.next[0],
    merge.graphs[0]!.function.id,
  );
  assert.notEqual(merge.graphs[0]!.function.id, original.graphs[0]!.function.id);
  assert.equal(
    discover(image, { assertions: [assertion(image, 4, 'retracted')] }).graphs.length,
    1,
  );
});

test('instruction/block/work limits, cancellation and decoder mismatch are bounded and typed', () => {
  const image = raw([0x90, 0x90, 0xc3]);
  const limited = discover(image, {}, { instructions: 1 });
  assert.equal(limited.coverage.state, 'partial');
  assert.equal(limited.graphs[0]!.instructions.length, 1);
  assert.ok(limited.graphs[0]!.gaps.some((gap) => gap.reason === 'budget'));
  assert.throws(
    () => discover(image, {}, { work: 1 }),
    (error: unknown) => error instanceof OperationError && error.code === 'resource_limit',
  );
  const branch = raw([0x75, 1, 0xc3, 0xc3]);
  assert.throws(
    () => discover(branch, {}, { blocks: 1 }),
    (error: unknown) => error instanceof OperationError && error.code === 'resource_limit',
  );
  const decoder = new X86Decoder({ formatting: false });
  const arm = new Arm64Decoder();
  const controller = new AbortController();
  controller.abort();
  try {
    assert.throws(
      () =>
        discoverFunctions(
          { image, decoder, revision: 0 },
          createOperationContext({ signal: controller.signal }),
        ),
      (error: unknown) => error instanceof OperationError && error.code === 'cancelled',
    );
    assert.throws(
      () => discoverFunctions({ image, decoder: arm, revision: 0 }, createOperationContext()),
      (error: unknown) => error instanceof OperationError && error.code === 'unsupported_target',
    );
  } finally {
    decoder.dispose();
    arm.dispose();
  }
});

test('newly observed backedges split block identities while preserving the function birth', () => {
  const image = raw([0x90, 0x90, 0x75, 0xfd, 0xc3]);
  const partial = discover(image, {}, { instructions: 2 });
  const complete = discover(image, { previous: partial.graphs, revision: 1 });
  assert.equal(complete.graphs[0]!.function.id, partial.graphs[0]!.function.id);
  const split = complete.lineage.find((item) => item.reason === 'split');
  assert.deepEqual(split?.previous, [partial.graphs[0]!.blocks[0]!.id]);
  assert.equal(split?.next.length, 2);
  assert.ok(
    complete.graphs[0]!.blocks.every((block) => block.id !== partial.graphs[0]!.blocks[0]!.id),
  );
  const again = discover(image, { previous: complete.graphs, revision: 2 });
  assert.deepEqual(
    again.graphs[0]!.blocks.map((block) => block.id),
    complete.graphs[0]!.blocks.map((block) => block.id),
  );
});

test('split file backing is decoded at VA coordinates without assuming byte references are file offsets', () => {
  const base = raw([0xe8, 0, 0, 0, 0, 0xc3]);
  const bytes = new Uint8Array([0xe8, 0, 0xff, 0xff, 0, 0, 0, 0xc3]);
  const sha256 = contentHash(bytes);
  const id = imageIdentity(sha256);
  const slice = sliceIdentity(id, 0n, 8n, 'x86_64');
  const mappings = [
    {
      id: 'first',
      va: 0x1000n,
      file_offset: 0n,
      file_size: 2n,
      memory_size: 2n,
      permissions: ['read', 'execute'] as const,
    },
    {
      id: 'second',
      va: 0x1002n,
      file_offset: 4n,
      file_size: 4n,
      memory_size: 4n,
      permissions: ['read', 'execute'] as const,
    },
  ];
  const image: LoadedImage = {
    ...base,
    id,
    sha256,
    selected_slice_id: slice,
    bytes: new ImmutableBytes(bytes),
    mappings,
    slices: [{ ...base.slices[0]!, id: slice, image_id: id, size: 8n }],
    address_map: new AddressMap({
      image_id: id,
      image_base: 0x1000n,
      byte_length: 8n,
      slice_offset: 0n,
      slice_size: 8n,
      mappings,
    }),
    entry_points: [{ image_id: id, space: 'va', value: 0x1000n }],
  };
  const result = discover(image);
  assert.equal(result.graphs[0]!.instructions[0]!.bytes.start.space, 'va');
  assert.equal(result.graphs[0]!.instructions[0]!.size, 5);
  assert.equal(
    result.references.find((reference) => reference.kind === 'call')?.to?.value,
    0x1005n,
  );
});

test('unexplained executable bytes root only candidates; assertion extents retain their evidence', () => {
  const image = raw([0x55, 0x48, 0x89, 0xe5, 0xc3]);
  // No loader root: the whole-image sweep roots the first unexplained instruction as a
  // candidate (never established) and then has explained every executable byte.
  const empty = discover({ ...image, entry_points: [] });
  assert.deepEqual(
    empty.graphs.map((graph) => [graph.function.entry.value, graph.function.boundary]),
    [[0x1000n, 'candidate']],
  );
  assert.equal(empty.enumeration, 'complete');
  assert.ok(
    empty.evidence.some(
      (item) =>
        empty.graphs[0]!.function.evidence_ids.includes(item.id) &&
        item.origin.kind === 'analysis' &&
        item.origin.rule === 'first instruction of unexplained executable bytes',
    ),
  );
  const claim = assertion(image, 0, 'asserted', [{ start: address(image, 0), size: 5n }]);
  const result = discover({ ...image, entry_points: [] }, { assertions: [claim] });
  assert.equal(result.graphs[0]!.function.boundary, 'candidate');
  assert.equal(result.boundary_claims[0]!.range.size, 5n);
  const evidence = result.evidence.find(
    (item) => item.id === result.boundary_claims[0]!.evidence_ids[0],
  );
  assert.ok(evidence?.derived_from.includes(claim.evidence.id));
});

test('cancellation during real decode prevents publication', () => {
  const image = raw(Array.from({ length: 100 }, () => 0x90));
  const controller = new AbortController();
  const decoder = new X86Decoder({ formatting: false });
  const operation = createOperationContext({ signal: controller.signal });
  let charged = 0;
  try {
    assert.throws(
      () =>
        discoverFunctions(
          { image, decoder, revision: 0 },
          {
            ...operation,
            checkpoint(work) {
              charged += work;
              if (charged >= 100) controller.abort();
              operation.checkpoint(work);
            },
          },
        ),
      (error: unknown) => error instanceof OperationError && error.code === 'cancelled',
    );
    assert.ok(charged < 200);
  } finally {
    decoder.dispose();
  }
});

/** entry calls f1 and f2; g1 and g2 are reached by nothing but the sweep; g2 calls g3. Each
 * function sits in its own 16-byte slot padded with int3. */
function strippedLayout(): LoadedImage {
  const slots = [
    [0xe8, 0x0b, 0, 0, 0, 0xe8, 0x16, 0, 0, 0, 0xc3], // 0x1000 entry: call 0x1010; call 0x1020
    [0x31, 0xc0, 0xff, 0xc0, 0xc3], // 0x1010 f1
    [0x31, 0xc0, 0xff, 0xc0, 0xff, 0xc0, 0xc3], // 0x1020 f2
    [0x48, 0x89, 0xf8, 0xc3], // 0x1030 g1
    [0xe8, 0x0b, 0, 0, 0, 0xc3], // 0x1040 g2: call 0x1050
    [0x31, 0xc0, 0xc3], // 0x1050 g3
  ];
  return raw(slots.flatMap((slot) => [...slot, ...Array<number>(16 - slot.length).fill(0xcc)]));
}
/** Publish every graph of each step (later steps replace a root's record) and continue from
 * each frontier until enumeration completes, as the service's continuation does. */
function discoverResumed(image: LoadedImage, instructions: number) {
  const published = new Map<bigint, FunctionGraph['function']>();
  let result = discover(image, {}, { instructions });
  let steps = 1;
  for (;;) {
    for (const graph of result.graphs) published.set(graph.function.entry.value, graph.function);
    if (!result.frontier) break;
    const frontier = result.frontier;
    result = discover(
      image,
      { functions: [...published.values()], resume: frontier },
      { instructions },
    );
    assert.notDeepEqual(result.frontier, frontier, 'every continuation makes progress');
    assert.ok(++steps < 20);
  }
  return {
    functions: [...published.values()].sort((a, b) => (a.entry.value < b.entry.value ? -1 : 1)),
    steps,
    last: result,
  };
}

test('whole-image discovery resumes from its frontier to the one-shot enumeration', () => {
  const image = strippedLayout();
  const shape = (fn: FunctionGraph['function']) => [
    fn.entry.value,
    fn.boundary,
    fn.analysis,
    fn.ranges.map((range) => [range.start.value, range.size]),
  ];
  const once = discover(image);
  assert.equal(once.enumeration, 'complete');
  assert.equal(once.frontier, null);
  assert.deepEqual(
    once.graphs.map((graph) => [graph.function.entry.value, graph.function.boundary]),
    [
      [0x1000n, 'established'],
      [0x1010n, 'established'],
      [0x1020n, 'established'],
      [0x1030n, 'candidate'],
      [0x1040n, 'candidate'],
      [0x1050n, 'candidate'],
    ],
  );
  // Four instructions per step: the largest function just fits, so every step finishes a root.
  const first = discover(image, {}, { instructions: 4 });
  assert.equal(first.enumeration, 'partial');
  assert.ok(first.frontier && first.frontier.pending.length > 0);
  const resumed = discoverResumed(image, 4);
  assert.ok(resumed.steps > 2);
  assert.equal(resumed.last.enumeration, 'complete');
  assert.deepEqual(
    resumed.functions.map(shape),
    once.graphs.map((graph) => shape(graph.function)),
  );
  // The continuation is a pure function of the image and the published frontier.
  assert.deepEqual(discoverResumed(image, 4), resumed);
});

test('a root larger than one step makes no progress instead of looping or claiming completion', () => {
  const image = strippedLayout();
  let result = discover(image, {}, { instructions: 3 });
  const published = new Map(
    result.graphs.map((graph) => [graph.function.entry.value, graph.function]),
  );
  let stalled = false;
  for (let step = 0; step < 10 && result.frontier && !stalled; step++) {
    const frontier = result.frontier;
    result = discover(
      image,
      { functions: [...published.values()], resume: frontier },
      { instructions: 3 },
    );
    for (const graph of result.graphs) published.set(graph.function.entry.value, graph.function);
    stalled = isDeepStrictEqual(result.frontier, frontier);
  }
  // f2 has four instructions: it stays pending, the continuation stalls on an unchanged
  // frontier and the enumeration never claims completion.
  assert.ok(stalled);
  assert.equal(result.enumeration, 'partial');
  assert.ok(result.frontier!.pending.some((root) => root.entry === 0x1020n));
});

test('complete enumeration explains fill and data, so addresses no function owns are proven absent', () => {
  const image = strippedLayout();
  const result = discover(image);
  assert.equal(result.enumeration, 'complete');
  const owner = (value: bigint) =>
    result.graphs.filter((graph) =>
      graph.function.ranges.some(
        (range) => value >= range.start.value && value < range.start.value + range.size,
      ),
    );
  // int3 fill after g1 belongs to no function; every instruction byte has exactly one owner.
  assert.deepEqual(owner(0x1034n), []);
  assert.deepEqual(
    owner(0x1031n).map((graph) => graph.function.entry.value),
    [0x1030n],
  );
  // Without the sweep's evidence the same bytes are not provably absent: a budget-limited
  // discovery leaves enumeration partial.
  assert.equal(discover(image, {}, { instructions: 4 }).enumeration, 'partial');
});

const TAIL_TARGET_RULE = 'unconditional jump at entry stack depth to code outside the root body';
/** Entry points of the graphs, and the targets promoted as tail-jump targets. */
function promoted(result: ReturnType<typeof discover>) {
  return result.graphs
    .filter((graph) =>
      result.evidence.some(
        (item) =>
          graph.function.evidence_ids.includes(item.id) &&
          item.origin.kind === 'analysis' &&
          item.origin.rule === TAIL_TARGET_RULE,
      ),
    )
    .map((graph) => graph.function.entry.value);
}
/** `int3`-padded x86 code placed at offsets from the image base. */
function x86Layout(parts: readonly (readonly [number, readonly number[]])[], size: number) {
  const bytes = Array<number>(size).fill(0xcc);
  for (const [offset, code] of parts) bytes.splice(offset, code.length, ...code);
  return bytes;
}
function arm64Image(words: readonly number[], entry: number): LoadedImage {
  const bytes = Buffer.alloc(words.length * 4);
  words.forEach((word, i) => bytes.writeUInt32LE(word, i * 4));
  const image = raw([...bytes], 'arm64');
  return { ...image, entry_points: [address(image, entry)] };
}

test('a jump at entry stack depth to code before the root roots a candidate whose table then proves', () => {
  // T (+0x00): switch (edi) over three cases through a rip-relative table of dword offsets at
  // +0x30; the entry (+0x40) is `mov edi, 2; jmp T`. On the entry's chain the index is a
  // constant, so only T as its own root proves the table.
  const code = x86Layout(
    [
      [
        0x00,
        [
          0x89, 0xf8, /* mov eax, edi */ 0x83, 0xff, 0x02, /* cmp edi, 2 */ 0x77, 0x1b,
          /* ja +0x22 */ 0x89, 0xf9, /* mov ecx, edi */ 0x48, 0x8d, 0x35, 0x20, 0, 0, 0,
          /* lea rsi, [rip+0x20] */ 0x48, 0x63, 0x0c, 0x8e, /* movsxd rcx, [rsi+rcx*4] */ 0x48,
          0x01, 0xf1, /* add rcx, rsi */ 0xff, 0xe1, /* jmp rcx */ 0xff, 0xc0, 0xc3,
          /* +0x19 inc eax; ret */ 0x01, 0xc0, 0xc3, /* +0x1c add eax, eax; ret */ 0x31, 0xc0, 0xc3,
          /* +0x1f xor eax, eax; ret */ 0xc3 /* +0x22 ret */,
        ],
      ],
      [0x30, [0xe9, 0xff, 0xff, 0xff, 0xec, 0xff, 0xff, 0xff, 0xef, 0xff, 0xff, 0xff]],
      [0x40, [0xbf, 0x02, 0, 0, 0, /* mov edi, 2 */ 0xe9, 0xb6, 0xff, 0xff, 0xff /* jmp T */]],
    ],
    0x50,
  );
  const plain = raw(code);
  const section = (name: string, start: number, end: number, execute: boolean) => ({
    id: `section-${name}`,
    name,
    segment_id: null,
    kind: 'section' as const,
    virtual_range: { start: address(plain, start), size: BigInt(end - start) },
    file_range: {
      start: { image_id: plain.id, space: 'file' as const, value: BigInt(start) },
      size: BigInt(end - start),
    },
    permissions: execute ? (['read', 'execute'] as const) : (['read'] as const),
    flags: 0n,
    evidence_ids: [],
  });
  const image: LoadedImage = {
    ...plain,
    sections: [
      section('.text', 0, 0x30, true),
      section('.rodata', 0x30, 0x40, false),
      section('.text.entry', 0x40, 0x50, true),
    ],
  };
  const rooted = { ...image, entry_points: [address(image, 0x40)] };
  const result = discover(rooted);
  assert.deepEqual(promoted(result), [0x1000n]);
  const target = result.graphs.find((graph) => graph.function.entry.value === 0x1000n)!;
  assert.equal(target.function.boundary, 'candidate');
  assert.equal(target.function.analysis, 'complete');
  assert.deepEqual(
    target.jump_tables?.map((table) => table.targets.map((item) => item.value)),
    [[0x1019n, 0x101cn, 0x101fn]],
  );
  // No case block is a function of its own.
  assert.deepEqual(
    result.graphs.map((graph) => graph.function.entry.value).filter((entry) => entry < 0x1030n),
    [0x1000n],
  );
  const entry = result.graphs.find((graph) => graph.function.entry.value === 0x1040n)!;
  assert.deepEqual(
    entry.instructions.map((instruction) => instruction.address.value),
    [0x1040n, 0x1045n],
  );
  const tail = result.references.find(
    (reference) => reference.from_function === entry.function.id && reference.kind === 'tail_call',
  );
  assert.equal(tail?.to_entity, target.function.id);
  // Selected discovery promotes nothing: without the published candidate, the entry's graph
  // still owns T's instructions.
  const selected = discover(rooted, { selected_entry: address(image, 0x40) });
  assert.equal(selected.graphs.length, 1);
  assert.ok(selected.graphs[0]!.instructions.some((item) => item.address.value === 0x1000n));
});

test('jumps inside the root body, or past the next root only, are promoted by body bounds', () => {
  // +0: jmp +5; +2: xor eax, eax; ret; +5: inc eax; jmp +2. Both targets are reached only by
  // jumps at entry depth, but lie inside the root's body (no root above it).
  const inside = raw([0xeb, 0x03, 0x31, 0xc0, 0xc3, 0xff, 0xc0, 0xeb, 0xf9]);
  const result = discover(inside);
  assert.deepEqual(promoted(result), []);
  assert.deepEqual(
    result.graphs.map((graph) => graph.function.entry.value),
    [0x1000n],
  );
  // The same jump past the next root (+0x10, asserted) leaves the body: promoted.
  const past = raw(
    x86Layout(
      [
        [0x00, [0xeb, 0x1e]],
        [0x10, [0xc3]],
        [0x20, [0x31, 0xc0, 0xc3]],
      ],
      0x30,
    ),
  );
  const beyond = discover(past, { assertions: [assertion(past, 0x10)] });
  assert.deepEqual(promoted(beyond), [0x1020n]);
  assert.equal(
    beyond.references.find((reference) => reference.kind === 'tail_call')?.to?.value,
    0x1020n,
  );
});

test('a jump below the entry stack depth, or at a depth that differs between paths, is no tail', () => {
  const at = (entry: readonly number[]) => {
    // T (+0): xor eax, eax; ret; the root at +0x10 ends with `jmp T`; +0x28: ret.
    const rel = -(0x10 + entry.length + 5);
    const jump = [0xe9, rel & 0xff, (rel >> 8) & 0xff, (rel >> 16) & 0xff, (rel >> 24) & 0xff];
    const image = raw(
      x86Layout(
        [
          [0x00, [0x31, 0xc0, 0xc3]],
          [0x10, [...entry, ...jump]],
          [0x28, [0xc3]],
        ],
        0x30,
      ),
    );
    return discover({ ...image, entry_points: [address(image, 0x10)] });
  };
  // push rbp; jmp T: the return address is no longer on top.
  const pushed = at([0x55]);
  assert.deepEqual(promoted(pushed), []);
  assert.ok(pushed.graphs[0]!.instructions.some((item) => item.address.value === 0x1000n));
  assert.ok(pushed.graphs.every((graph) => graph.function.boundary !== 'conflicting'));
  // test edi, edi; je +1; push rbx; jmp T: one path pushed, one did not.
  assert.deepEqual(promoted(at([0x85, 0xff, 0x74, 0x01, 0x53])), []);
  // push rbp; sub rsp, 8; call +0x28; add rsp, 8; pop rbp; jmp T: restored around a call.
  assert.deepEqual(
    promoted(at([0x55, 0x48, 0x83, 0xec, 0x08, 0xe8, 0x0e, 0, 0, 0, 0x48, 0x83, 0xc4, 0x08, 0x5d])),
    [0x1000n],
  );
});

test('a target also reached by a conditional branch stays inside its root without conflict', () => {
  // T (+0): xor eax, eax; ret; root (+0x10): test edi, edi; je T; jmp T.
  const image = raw(
    x86Layout(
      [
        [0x00, [0x31, 0xc0, 0xc3]],
        [0x10, [0x85, 0xff, 0x0f, 0x84, 0xe8, 0xff, 0xff, 0xff, 0xe9, 0xe3, 0xff, 0xff, 0xff]],
      ],
      0x30,
    ),
  );
  const result = discover({ ...image, entry_points: [address(image, 0x10)] });
  assert.deepEqual(promoted(result), []);
  assert.deepEqual(
    result.graphs.map((graph) => [graph.function.entry.value, graph.function.boundary]),
    [[0x1010n, 'established']],
  );
  assert.ok(result.graphs[0]!.instructions.some((item) => item.address.value === 0x1000n));
});

test('an ARM64 frame popped by post-index writeback before `b` is a tail jump', () => {
  const frame = [
    0xd2800020, // +0x00 T: mov x0, #1
    0xd65f03c0, // +0x04 ret
    0xd503201f, // +0x08 nop
    0xd503201f, // +0x0c nop
    0xa9bf7bfd, // +0x10 stp x29, x30, [sp, #-16]!
    0x910003fd, // +0x14 mov x29, sp
    0x94000004, // +0x18 bl +0x28
    0xa8c17bfd, // +0x1c ldp x29, x30, [sp], #16
    0x17fffff8, // +0x20 b T
    0xd503201f, // +0x24 nop
    0xd65f03c0, // +0x28 ret
  ];
  const result = discover(arm64Image(frame, 0x10));
  assert.deepEqual(promoted(result), [0x1000n]);
  const entry = result.graphs.find((graph) => graph.function.entry.value === 0x1010n)!;
  assert.equal(
    result.references.find(
      (reference) =>
        reference.from_function === entry.function.id && reference.kind === 'tail_call',
    )?.to?.value,
    0x1000n,
  );
  // Without the pop, SP at the jump is 16 below the entry SP.
  const unpopped = discover(
    arm64Image([...frame.slice(0, 7), 0xd503201f, ...frame.slice(8)], 0x10),
  );
  assert.deepEqual(promoted(unpopped), []);
});
