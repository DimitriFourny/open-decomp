import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  AddressMap, ImmutableBytes, OperationError, contentHash, createOperationContext, imageIdentity, sliceIdentity,
  fingerprint, type Address, type AddressRange, type Evidence, type LoadedImage, type Loader,
} from '../../src/core/index.js';
import { Arm64Decoder } from '../../src/decoders/arm64/index.js';
import { X86Decoder } from '../../src/decoders/x86_64/index.js';
import { MachOLoader } from '../../src/loaders/macho/index.js';
import { PELoader } from '../../src/loaders/pe/index.js';
import { discoverFunctions, type DiscoveryInput, type FunctionAssertion } from '../../src/analysis/discovery/index.js';

function load(path: string, loader: Loader): LoadedImage {
  const bytes = readFileSync(path);
  const sha256 = contentHash(bytes);
  return loader.load({ bytes: new ImmutableBytes(bytes), image_id: imageIdentity(sha256), sha256, slice_id: null }, createOperationContext());
}
function raw(bytes: readonly number[], architecture: 'x86_64' | 'arm64' = 'x86_64'): LoadedImage {
  const buffer = Uint8Array.from(bytes);
  const sha256 = contentHash(buffer);
  const id = imageIdentity(sha256);
  const slice = sliceIdentity(id, 0n, BigInt(buffer.length), architecture);
  const mappings = [{ id: 'test-code', va: 0x1000n, memory_size: BigInt(buffer.length), file_offset: 0n, file_size: BigInt(buffer.length), permissions: ['read', 'execute'] as const }];
  return { id, sha256, selected_slice_id: slice, bytes: new ImmutableBytes(buffer), image_base: 0x1000n,
    slices: [{ id: slice, image_id: id, offset: 0n, size: BigInt(buffer.length), architecture, subtype: 'all', supported: true }],
    target: architecture === 'x86_64' ? { format: 'pe', architecture, abi: 'windows-x64', endian: 'little', address_bits: 64, features: [] } : { format: 'macho', architecture, abi: 'darwin-arm64', endian: 'little', address_bits: 64, features: [] },
    mappings, address_map: new AddressMap({ image_id: id, image_base: 0x1000n, byte_length: BigInt(buffer.length), slice_offset: 0n, slice_size: BigInt(buffer.length), mappings }),
    entry_points: [{ image_id: id, space: 'va', value: 0x1000n }], hints: [], headers: [], sections: [], symbols: [], imports: [], exports: [], relocations: [], evidence: [], diagnostics: [], capabilities: [] };
}
function address(image: LoadedImage, offset: number): Address { return { image_id: image.id, space: 'va', value: image.image_base + BigInt(offset) }; }
function assertion(image: LoadedImage, offset: number, status: 'asserted' | 'retracted' = 'asserted', ranges?: readonly AddressRange[]): FunctionAssertion {
  const evidence: Evidence = { id: `evidence_${fingerprint(['test-assertion', offset, status])}`, origin: { kind: 'assertion', author: 'test', agent: 'user', status }, claim: 'Function entry', derived_from: [], conflicts_with: [], revision: 1 };
  return { entry: address(image, offset), evidence, ...(ranges ? { ranges } : {}) };
}
function discover(image: LoadedImage, options: Partial<Omit<DiscoveryInput, 'image' | 'decoder'>> = {}, budget = {}) {
  const decoder = image.target.architecture === 'arm64' ? new Arm64Decoder() : new X86Decoder({ formatting: false });
  try { return discoverFunctions({ image, decoder, revision: 0, ...options }, createOperationContext({ budget })); }
  finally { decoder.dispose(); }
}

for (const name of ['macho-arm64-symbols', 'macho-arm64-stripped', 'libcorpus-arm64-symbols.dylib', 'libcorpus-arm64-stripped.dylib', 'corpus-symbols.dll', 'corpus-stripped.dll', 'pe-x86_64-symbols.exe', 'pe-x86_64-stripped.exe']) {
  test(`actual loader/decoder discovery: ${name}`, () => {
    const arm = name.includes('arm64');
    const image = load(`fixtures/bin/${name}`, arm ? new MachOLoader() : new PELoader());
    const result = discover(image);
    assert.ok(result.references.some(reference => reference.kind === 'call' || reference.kind === 'tail_call'));
    for (const graph of result.graphs) {
      assert.equal(graph.slice_id, image.selected_slice_id);
      assert.ok(graph.blocks.every(block => block.edges.every(edge => edge.kind !== 'call')));
      const blockIds = new Set(graph.blocks.map(block => block.id));
      for (const block of graph.blocks) for (const edge of block.edges) if (edge.to !== null) assert.ok(blockIds.has(edge.to));
    }
    if (name === 'macho-arm64-symbols' || name.startsWith('corpus-')) {
      // Addresses and control flow independently recorded by LLVM in fixtures/metadata.
      const arithmetic = result.graphs.find(graph => graph.function.entry.value === (arm ? 0x100000574n : 0x180001030n));
      assert.ok(arithmetic);
      assert.equal(arithmetic.instructions.at(-1)?.flow.kind, 'return');
      assert.equal(arithmetic.instructions.length, arm ? 5 : 4);
      const loop = result.graphs.find(graph => graph.function.entry.value === (arm ? 0x100000594n : 0x180001050n));
      assert.ok(loop?.blocks.some(block => block.edges.some(edge => edge.kind === 'branch' && edge.target && edge.target.value <= block.ranges[0]!.start.value)));
      const direct = result.references.find(reference => reference.kind === 'call' && reference.from.value === (arm ? 0x1000005e4n : 0x18000108bn));
      if (arm) assert.equal(direct?.to?.value, 0x100000548n);
      assert.ok(result.references.some(reference => reference.status === 'unresolved'));
    }
  });
}

for (const file of ['macho-arm64-symbols', 'macho-arm64-stripped']) test(`declared constants in executable Mach-O segments are not functions: ${file}`, () => {
  const image = load(`fixtures/bin/${file}`, new MachOLoader());
  const constant = image.sections.find(item => item.kind === 'section' && item.name === '__const')?.virtual_range;
  assert.ok(constant);
  const result = discover(image), end = constant.start.value + constant.size;
  assert.ok(!result.graphs.some(graph => graph.function.entry.value >= constant.start.value && graph.function.entry.value < end));
  assert.ok(!result.graphs.some(graph => graph.instructions.some(instruction => instruction.address.value >= constant.start.value && instruction.address.value < end)));
  const backing = image.address_map.translate(constant.start, 'file');
  assert.equal(backing.kind, 'mapped');
  assert.equal(image.bytes.at(Number(backing.address.value)), 0x6f); // 'o', not an instruction seed.
});

test('zero-sized object symbols defeat export-only code guesses without overriding explicit assertions', () => {
  const image = raw([0xc3, 0x90, 0xc3]), target = address(image, 1);
  const named = { id: `entity_${fingerprint('object-symbol')}`, original_name: 'data_bytes', display_name: null, evidence_ids: [] };
  const withObject: LoadedImage = { ...image,
    symbols: [{ ...named, kind: 'object', address: target, size: null, binding: 'global' }],
    exports: [{ ...named, id: `entity_${fingerprint('object-export')}`, address: target, ordinal: null, forwarder: null }] };
  assert.deepEqual(discover(withObject).graphs.map(graph => graph.function.entry.value), [0x1000n]);
  assert.ok(discover(withObject, { assertions: [assertion(withObject, 1)] }).graphs.some(graph => graph.function.entry.value === target.value));
});

test('recursive calls are references, loop targets split blocks, dead bytes are not swept', () => {
  // call +8; test eax,eax; jne test; ret; dead int3; callee ret
  const image = raw([0xe8, 8, 0, 0, 0, 0x85, 0xc0, 0x75, 0xfc, 0xc3, 0xcc, 0xcc, 0xcc, 0xc3]);
  const result = discover(image);
  assert.deepEqual(result.graphs.map(graph => graph.function.entry.value), [0x1000n, 0x100dn]);
  const caller = result.graphs[0]!;
  assert.deepEqual(caller.instructions.map(instruction => instruction.address.value), [0x1000n, 0x1005n, 0x1007n, 0x1009n]);
  assert.equal(caller.blocks.length, 3);
  const loop = caller.blocks.find(block => block.ranges[0]!.start.value === 0x1005n)!;
  assert.ok(loop.edges.some(edge => edge.to === loop.id));
  assert.equal(result.references.find(reference => reference.kind === 'call')?.to_entity, result.graphs[1]!.function.id);
  assert.ok(caller.blocks.every(block => block.edges.every(edge => edge.to !== result.graphs[1]!.blocks[0]!.id)));
});

test('ARM direct calls and loops use real fixed-width decoding', () => {
  const words = [0x94000004, 0x71000400, 0x54ffffe1, 0xd65f03c0, 0xd65f03c0]; // bl +16; subs w0,w0,#1; b.ne -4; ret; ret
  const bytes = Buffer.alloc(words.length * 4); words.forEach((word, i) => bytes.writeUInt32LE(word, i * 4));
  const result = discover(raw([...bytes], 'arm64'));
  assert.equal(result.graphs.length, 2);
  assert.equal(result.references.find(reference => reference.kind === 'call')?.to?.value, 0x1010n);
  assert.ok(result.graphs[0]!.blocks.some(block => block.edges.some(edge => edge.to === block.id)));
});

test('noncontiguous regions, file-coordinate data, and reachable data conflicts remain explicit', () => {
  const base = raw([0xeb, 4, 0xff, 0xff, 0xff, 0xff, 0xc3]);
  const image: LoadedImage = { ...base, hints: [
    { kind: 'function', address: address(base, 0), size: 7n, evidence_ids: [] },
    { kind: 'data', range: { start: { ...address(base, 0), space: 'file', value: 2n }, size: 4n }, encoding: 'jump_table', evidence_ids: [] },
  ] };
  const result = discover(image);
  assert.deepEqual(result.graphs[0]!.function.ranges.map(range => [range.start.value, range.size]), [[0x1000n, 2n], [0x1006n, 1n]]);
  assert.ok(result.graphs[0]!.gaps.some(gap => gap.reason === 'data' && gap.range.size === 4n));
  assert.equal(result.jump_tables[0]!.status, 'candidate');
  const conflict = discover(image, { assertions: [assertion(image, 2)] }).graphs.find(graph => graph.function.entry.value === 0x1002n)!;
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
  const shared = result.overlaps.find(overlap => overlap.kind === 'shared_tail');
  assert.equal(shared?.range.start.value, 0x1008n);
  assert.equal(shared?.function_ids.length, 2);
  const tails = discover(base, { assertions: [assertion(base, 4), assertion(base, 8)] });
  assert.equal(tails.references.filter(reference => reference.kind === 'tail_call').length, 2);
  assert.ok(tails.graphs.slice(0, 2).every(graph => graph.blocks[0]!.edges[0]!.kind === 'tail_call' && graph.blocks[0]!.edges[0]!.to === null));
});

test('overlapping instruction streams and fallthrough boundary conflicts are not suppressed', () => {
  const image = raw([0xb8, 0x90, 0x90, 0x90, 0x90, 0xc3]);
  const result = discover(image, { assertions: [assertion(image, 1)] });
  assert.ok(result.overlaps.some(overlap => overlap.kind === 'overlapping_instructions'));
  assert.ok(result.graphs.every(graph => graph.function.boundary === 'conflicting'));
  const fallthrough = raw([0x90, 0xc3]);
  assert.equal(discover(fallthrough, { assertions: [assertion(fallthrough, 1)] }).graphs[0]!.function.boundary, 'conflicting');
});

test('invalid encodings, truncation and unbacked direct targets stop without synthetic traps', () => {
  for (const bytes of [[0x0f], [0x0f, 0xff], [0xe9, 0xff, 0, 0, 0]]) {
    const result = discover(raw(bytes));
    assert.equal(result.graphs[0]!.coverage.state, 'partial');
    assert.ok(result.graphs[0]!.blocks.every(block => block.edges.every(edge => edge.kind !== 'trap')));
  }
});

test('renames preserve IDs, actual splits and merges mint lineage and never reuse old IDs', () => {
  const image = raw([0xeb, 2, 0xcc, 0xcc, 0xc3]);
  const original = discover(image);
  const renamed = discover({ ...image, symbols: [{ id: `entity_${fingerprint('name')}`, kind: 'function', address: address(image, 0), size: null, original_name: 'renamed', display_name: 'renamed', binding: 'global', evidence_ids: [] }] }, { previous: original.graphs, revision: 1 });
  assert.equal(renamed.graphs[0]!.function.id, original.graphs[0]!.function.id);
  assert.deepEqual(renamed.lineage, []);
  const split = discover(image, { previous: original.graphs, assertions: [assertion(image, 4)], revision: 1 });
  const lineage = split.lineage.find(item => item.reason === 'split');
  assert.deepEqual(lineage?.previous, [original.graphs[0]!.function.id]);
  assert.deepEqual(new Set(lineage?.next), new Set(split.graphs.map(graph => graph.function.id)));
  assert.ok(split.graphs.every(graph => graph.function.id !== original.graphs[0]!.function.id));
  const stable = discover(image, { previous: split.graphs, assertions: [assertion(image, 4)], revision: 2 });
  assert.deepEqual(stable.graphs.map(graph => graph.function.id), split.graphs.map(graph => graph.function.id));
  assert.deepEqual(stable.lineage, []);
  const merge = discover(image, { previous: split.graphs, revision: 2 });
  assert.equal(merge.lineage.find(item => item.reason === 'merge')?.next[0], merge.graphs[0]!.function.id);
  assert.notEqual(merge.graphs[0]!.function.id, original.graphs[0]!.function.id);
  assert.equal(discover(image, { assertions: [assertion(image, 4, 'retracted')] }).graphs.length, 1);
});

test('instruction/block/work limits, cancellation and decoder mismatch are bounded and typed', () => {
  const image = raw([0x90, 0x90, 0xc3]);
  const limited = discover(image, {}, { instructions: 1 });
  assert.equal(limited.coverage.state, 'partial');
  assert.equal(limited.graphs[0]!.instructions.length, 1);
  assert.ok(limited.graphs[0]!.gaps.some(gap => gap.reason === 'budget'));
  assert.throws(() => discover(image, {}, { work: 1 }), (error: unknown) => error instanceof OperationError && error.code === 'resource_limit');
  const branch = raw([0x75, 1, 0xc3, 0xc3]);
  assert.throws(() => discover(branch, {}, { blocks: 1 }), (error: unknown) => error instanceof OperationError && error.code === 'resource_limit');
  const decoder = new X86Decoder({ formatting: false });
  const arm = new Arm64Decoder();
  const controller = new AbortController(); controller.abort();
  try {
    assert.throws(() => discoverFunctions({ image, decoder, revision: 0 }, createOperationContext({ signal: controller.signal })), (error: unknown) => error instanceof OperationError && error.code === 'cancelled');
    assert.throws(() => discoverFunctions({ image, decoder: arm, revision: 0 }, createOperationContext()), (error: unknown) => error instanceof OperationError && error.code === 'unsupported_target');
  } finally { decoder.dispose(); arm.dispose(); }
});

test('newly observed backedges split block identities while preserving the function birth', () => {
  const image = raw([0x90, 0x90, 0x75, 0xfd, 0xc3]);
  const partial = discover(image, {}, { instructions: 2 });
  const complete = discover(image, { previous: partial.graphs, revision: 1 });
  assert.equal(complete.graphs[0]!.function.id, partial.graphs[0]!.function.id);
  const split = complete.lineage.find(item => item.reason === 'split');
  assert.deepEqual(split?.previous, [partial.graphs[0]!.blocks[0]!.id]);
  assert.equal(split?.next.length, 2);
  assert.ok(complete.graphs[0]!.blocks.every(block => block.id !== partial.graphs[0]!.blocks[0]!.id));
  const again = discover(image, { previous: complete.graphs, revision: 2 });
  assert.deepEqual(again.graphs[0]!.blocks.map(block => block.id), complete.graphs[0]!.blocks.map(block => block.id));
});

test('split file backing is decoded at VA coordinates without assuming byte references are file offsets', () => {
  const base = raw([0xe8, 0, 0, 0, 0, 0xc3]);
  const bytes = new Uint8Array([0xe8, 0, 0xff, 0xff, 0, 0, 0, 0xc3]);
  const sha256 = contentHash(bytes);
  const id = imageIdentity(sha256);
  const slice = sliceIdentity(id, 0n, 8n, 'x86_64');
  const mappings = [
    { id: 'first', va: 0x1000n, file_offset: 0n, file_size: 2n, memory_size: 2n, permissions: ['read', 'execute'] as const },
    { id: 'second', va: 0x1002n, file_offset: 4n, file_size: 4n, memory_size: 4n, permissions: ['read', 'execute'] as const },
  ];
  const image: LoadedImage = { ...base, id, sha256, selected_slice_id: slice, bytes: new ImmutableBytes(bytes), mappings,
    slices: [{ ...base.slices[0]!, id: slice, image_id: id, size: 8n }],
    address_map: new AddressMap({ image_id: id, image_base: 0x1000n, byte_length: 8n, slice_offset: 0n, slice_size: 8n, mappings }),
    entry_points: [{ image_id: id, space: 'va', value: 0x1000n }] };
  const result = discover(image);
  assert.equal(result.graphs[0]!.instructions[0]!.bytes.start.space, 'va');
  assert.equal(result.graphs[0]!.instructions[0]!.size, 5);
  assert.equal(result.references.find(reference => reference.kind === 'call')?.to?.value, 0x1005n);
});

test('ungrounded prologue bytes never create functions and assertion extents retain their evidence', () => {
  const image = raw([0x55, 0x48, 0x89, 0xe5, 0xc3]);
  const empty = discover({ ...image, entry_points: [] });
  assert.deepEqual(empty.graphs, []);
  assert.equal(empty.coverage.state, 'partial');
  const claim = assertion(image, 0, 'asserted', [{ start: address(image, 0), size: 5n }]);
  const result = discover({ ...image, entry_points: [] }, { assertions: [claim] });
  assert.equal(result.graphs[0]!.function.boundary, 'candidate');
  assert.equal(result.boundary_claims[0]!.range.size, 5n);
  const evidence = result.evidence.find(item => item.id === result.boundary_claims[0]!.evidence_ids[0]);
  assert.ok(evidence?.derived_from.includes(claim.evidence.id));
});

test('cancellation during real decode prevents publication', () => {
  const image = raw(Array.from({ length: 100 }, () => 0x90));
  const controller = new AbortController();
  const decoder = new X86Decoder({ formatting: false });
  const operation = createOperationContext({ signal: controller.signal });
  let charged = 0;
  try {
    assert.throws(() => discoverFunctions({ image, decoder, revision: 0 }, {
      ...operation,
      checkpoint(work) {
        charged += work;
        if (charged >= 100) controller.abort();
        operation.checkpoint(work);
      },
    }), (error: unknown) => error instanceof OperationError && error.code === 'cancelled');
    assert.ok(charged < 200);
  } finally { decoder.dispose(); }
});
