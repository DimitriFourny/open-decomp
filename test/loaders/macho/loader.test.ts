import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  createOperationContext,
  contentHash,
  imageIdentity,
  ImmutableBytes,
  NATIVE_SYMBOL_TABLES_FEATURE,
  OperationError,
  type LoadedImage,
} from '../../../src/core/index.js';
import { MachOLoader, MachOError } from '../../../src/loaders/macho/index.js';
import { Arm64Decoder } from '../../../src/decoders/arm64/index.js';
import { discoverFunctions } from '../../../src/analysis/discovery/index.js';

const loader = new MachOLoader();
const fixture = readFileSync(new URL('../../../fixtures/bin/macho-arm64-symbols', import.meta.url));
function load(bytes: Uint8Array, slice_id: string | null = null): LoadedImage {
  const sha256 = contentHash(bytes);
  return loader.load(
    { image_id: imageIdentity(sha256), sha256, bytes: new ImmutableBytes(bytes), slice_id },
    createOperationContext({}),
  );
}
function command(cmd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  bytes.writeUInt32LE(cmd, 0);
  bytes.writeUInt32LE(size, 4);
  return bytes;
}
/** Small format-valid executable, not a parser mock. Payloads are written by each boundary case. */
function image(extra: readonly Buffer[] = []): Buffer {
  const bytes = Buffer.alloc(4096),
    segment = command(25, 152);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x100000c, 4);
  bytes.writeUInt32LE(2, 12);
  segment.write('__TEXT', 8);
  segment.writeBigUInt64LE(0x100000000n, 24);
  segment.writeBigUInt64LE(4096n, 32);
  segment.writeBigUInt64LE(4096n, 48);
  segment.writeUInt32LE(7, 56);
  segment.writeUInt32LE(5, 60);
  segment.writeUInt32LE(1, 64);
  segment.write('__text', 72);
  segment.write('__TEXT', 88);
  segment.writeBigUInt64LE(0x100000200n, 104);
  segment.writeBigUInt64LE(256n, 112);
  segment.writeUInt32LE(512, 120);
  segment.writeUInt32LE(0x80000400, 136);
  const commands = [segment, ...extra],
    size = commands.reduce((total, entry) => total + entry.length, 0);
  assert.ok(size + 32 <= 512);
  bytes.writeUInt32LE(commands.length, 16);
  bytes.writeUInt32LE(size, 20);
  let p = 32;
  for (const entry of commands) {
    entry.copy(bytes, p);
    p += entry.length;
  }
  bytes.writeUInt32LE(0xd65f03c0, 512);
  return bytes;
}
function linkedit(cmd: number, offset: number, size: number): Buffer {
  const bytes = command(cmd, 16);
  bytes.writeUInt32LE(offset, 8);
  bytes.writeUInt32LE(size, 12);
  return bytes;
}
function fat(thin: Buffer, fat64 = false, little = false): Buffer {
  const bytes = Buffer.alloc(8192 + thin.length),
    write32 = (value: number, p: number) =>
      little ? bytes.writeUInt32LE(value, p) : bytes.writeUInt32BE(value, p),
    write64 = (value: bigint, p: number) =>
      little ? bytes.writeBigUInt64LE(value, p) : bytes.writeBigUInt64BE(value, p);
  write32(fat64 ? 0xcafebabf : 0xcafebabe, 0);
  write32(2, 4);
  const stride = fat64 ? 32 : 20;
  for (let i = 0; i < 2; i++) {
    const p = 8 + i * stride;
    write32(0x100000c, p);
    write32(thin.readUInt32LE(8), p + 4);
    if (fat64) {
      write64(BigInt(4096 + i * 4096), p + 8);
      write64(BigInt(thin.length), p + 16);
      write32(12, p + 24);
    } else {
      write32(4096 + i * 4096, p + 8);
      write32(thin.length, p + 12);
      write32(12, p + 16);
    }
    thin.copy(bytes, 4096 + i * 4096);
  }
  return bytes;
}

function symbolImage(
  symbols: readonly (readonly [string, number])[],
  extra: readonly Buffer[] = [],
): Buffer {
  const table = command(2, 24),
    strings = Buffer.from(`\0${symbols.map(([name]) => name).join('\0')}\0`);
  table.writeUInt32LE(2048, 8);
  table.writeUInt32LE(symbols.length, 12);
  table.writeUInt32LE(3072, 16);
  table.writeUInt32LE(strings.length, 20);
  const bytes = image([table, ...extra]);
  strings.copy(bytes, 3072);
  let stringOffset = 1;
  for (const [index, [name, offset]] of symbols.entries()) {
    const p = 2048 + index * 16;
    bytes.writeUInt32LE(stringOffset, p);
    bytes[p + 4] = 0x0f;
    bytes[p + 5] = 1;
    bytes.writeBigUInt64LE(0x100000000n + BigInt(offset), p + 8);
    stringOffset += Buffer.byteLength(name) + 1;
  }
  return bytes;
}
function discover(loaded: LoadedImage) {
  const decoder = new Arm64Decoder();
  try {
    return discoverFunctions({ image: loaded, decoder, revision: 0 }, createOperationContext());
  } finally {
    decoder.dispose();
  }
}

test('section-symbol classification requires membership, including exact ends and stub sections', () => {
  for (const [flags, kind] of [
    [0x80000400, 'function'],
    [8, 'function'],
    [0, 'object'],
  ] as const) {
    const bytes = symbolImage([
      ['_before', 508],
      ['_first', 512],
      ['_last', 764],
      ['_after', 768],
    ]);
    bytes.writeUInt32LE(flags, 32 + 72 + 64);
    const loaded = load(bytes),
      section = loaded.sections.find((record) => record.kind === 'section')!;
    assert.deepEqual(
      loaded.symbols.map((symbol) => symbol.kind),
      ['unknown', kind, kind, 'unknown'],
    );
    assert.deepEqual(
      loaded.exports.map((record) => record.address?.value),
      [508n, 512n, 764n, 768n].map((offset) => loaded.image_base + offset),
    );
    for (const symbol of loaded.symbols) {
      assert.ok(section.evidence_ids.every((id) => symbol.evidence_ids.includes(id)));
      assert.ok(
        symbol.evidence_ids.every((id) => loaded.evidence.some((proof) => proof.id === id)),
      );
    }
    bytes.writeBigUInt64LE(0n, 32 + 72 + 40);
    assert.ok(load(bytes).symbols.every((symbol) => symbol.kind === 'unknown'));
  }
});

for (const universal of [false, true])
  test(`native headers defeat symbol/export code guesses without hiding metadata (${universal ? 'universal' : 'thin'})`, () => {
    const name = Buffer.from('_trie_metadata\0');
    const trie = Buffer.from([0, 1, ...name, 3 + name.length, 2, 0, 64, 0]);
    const thin = symbolImage(
      [
        ['_image_record', 0],
        ['_command_record', 32],
        ['_code', 512],
        ['_alias', 512],
      ],
      [linkedit(0x80000033, 1024, trie.length)],
    );
    trie.copy(thin, 1024);
    const bytes = universal ? fat(thin) : thin;
    const inspected = loader.inspect(
      new ImmutableBytes(bytes),
      imageIdentity(contentHash(bytes)),
      createOperationContext(),
    );
    for (const slice of inspected.slices) {
      const loaded = load(bytes, slice.id),
        commandEnd = BigInt(32 + thin.readUInt32LE(20));
      const metadata = loaded.hints.find(
        (hint) => hint.kind === 'data' && hint.range.start.space === 'file',
      );
      assert.ok(metadata?.kind === 'data');
      assert.deepEqual(metadata.range, {
        start: { image_id: loaded.id, space: 'file', value: slice.offset },
        size: commandEnd,
      });
      assert.equal(
        loaded.headers.filter((header) => header.kind === 'load_command').length,
        thin.readUInt32LE(16),
      );
      for (const id of metadata.evidence_ids) {
        const proof = loaded.evidence.find((record) => record.id === id);
        assert.ok(proof?.origin.kind === 'binary');
        assert.deepEqual(proof.origin.range, metadata.range);
      }
      assert.deepEqual(
        loaded.symbols.map((symbol) => [symbol.original_name, symbol.address?.value, symbol.kind]),
        [
          ['_image_record', loaded.image_base, 'unknown'],
          ['_command_record', loaded.image_base + 32n, 'unknown'],
          ['_code', loaded.image_base + 512n, 'function'],
          ['_alias', loaded.image_base + 512n, 'function'],
        ],
      );
      assert.deepEqual(
        loaded.exports.map((record) => [record.original_name, record.address?.value]),
        [
          ['_image_record', loaded.image_base],
          ['_command_record', loaded.image_base + 32n],
          ['_code', loaded.image_base + 512n],
          ['_alias', loaded.image_base + 512n],
          ['_trie_metadata', loaded.image_base + 64n],
        ],
      );
      assert.ok(
        loaded.exports.every(
          (record) =>
            record.evidence_ids.length > 0 &&
            record.evidence_ids.every((id) => loaded.evidence.some((proof) => proof.id === id)),
        ),
      );
      const result = discover(loaded);
      assert.equal(result.graphs.length, 1);
      assert.equal(result.graphs[0]?.function.entry.value, loaded.image_base + 512n);
      assert.equal(result.graphs[0]?.function.boundary, 'established');
      assert.deepEqual(
        result.graphs[0]?.instructions.map((instruction) => instruction.flow.kind),
        ['return'],
      );
      const graphProofs = result.graphs[0]!.function.evidence_ids.map((id) =>
        result.evidence.find((proof) => proof.id === id)!,
      );
      for (const symbol of loaded.symbols.filter((record) => record.kind === 'function')) {
        assert.ok(
          graphProofs.some((proof) =>
            symbol.evidence_ids.every((id) => proof.derived_from.includes(id)),
          ),
        );
      }
      const decoder = new Arm64Decoder();
      try {
        const decoded = decoder.decode(
          {
            image: loaded,
            mode: 'a64',
            features: loaded.target.features,
            regions: [
              {
                start: { image_id: loaded.id, space: 'va', value: loaded.image_base },
                size: commandEnd,
              },
              {
                start: { image_id: loaded.id, space: 'va', value: loaded.image_base + 512n },
                size: 4n,
              },
            ],
          },
          createOperationContext(),
        );
        assert.deepEqual(
          decoded.instructions.map((instruction) => instruction.address.value),
          [loaded.image_base + 512n],
        );
        assert.equal(decoded.instructions[0]?.bytes.start.value, slice.offset + 512n);
        assert.ok(decoded.gaps.length > 0 && decoded.gaps.every((gap) => gap.reason === 'data'));
        const padding = decoder.decode(
          {
            image: loaded,
            mode: 'a64',
            features: loaded.target.features,
            regions: [
              {
                start: { image_id: loaded.id, space: 'file', value: slice.offset + commandEnd },
                size: 4n,
              },
            ],
          },
          createOperationContext(),
        );
        assert.deepEqual(
          padding.instructions.map((instruction) => instruction.address.value),
          [loaded.image_base + commandEnd],
        );
      } finally {
        decoder.dispose();
      }
    }
  });

test('header-overlapping code sections, explicit entries and function starts retain honest conflicts', () => {
  const main = command(0x80000028, 24);
  const bytes = symbolImage(
    [
      ['_claimed_header', 0],
      ['_valid_code', 512],
    ],
    [main, linkedit(38, 1024, 2)],
  );
  bytes.writeBigUInt64LE(0x100000000n, 32 + 72 + 32);
  bytes.writeBigUInt64LE(768n, 32 + 72 + 40);
  bytes.writeUInt32LE(0, 32 + 72 + 48);
  bytes.set([32, 0], 1024);
  const loaded = load(bytes),
    result = discover(loaded);
  assert.equal(loaded.symbols[0]?.kind, 'function'); // Preserve the contradictory native section claim.
  assert.equal(loaded.entry_points[0]?.value, loaded.image_base);
  assert.ok(
    loaded.hints.some(
      (hint) => hint.kind === 'function' && hint.address.value === loaded.image_base + 32n,
    ),
  );
  for (const offset of [0n, 32n]) {
    const graph = result.graphs.find(
      (record) => record.function.entry.value === loaded.image_base + offset,
    );
    assert.ok(graph);
    assert.equal(graph.function.boundary, 'conflicting');
    assert.equal(graph.coverage.state, 'partial');
    assert.deepEqual(graph.instructions, []);
    assert.equal(graph.gaps[0]?.reason, 'data');
    assert.ok(
      graph.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'conflicting_evidence' &&
          diagnostic.evidence_ids.some((id) =>
            loaded.hints.some((hint) => hint.kind === 'data' && hint.evidence_ids.includes(id)),
          ),
      ),
    );
  }
  const valid = result.graphs.find(
    (graph) => graph.function.entry.value === loaded.image_base + 512n,
  );
  assert.equal(valid?.function.boundary, 'established');
  assert.deepEqual(
    valid?.instructions.map((instruction) => instruction.flow.kind),
    ['return'],
  );
});

test('native data-in-code conflicts survive header ownership while adjacent entries remain code', () => {
  const main = command(0x80000028, 24);
  main.writeBigUInt64LE(516n, 8);
  const bytes = symbolImage(
    [
      ['_literal_claim', 512],
      ['_entry_code', 516],
    ],
    [main, linkedit(38, 1024, 3), linkedit(41, 1040, 8)],
  );
  bytes.set([0x80, 4, 0], 1024);
  bytes.writeUInt32LE(512, 1040);
  bytes.writeUInt16LE(4, 1044);
  bytes.writeUInt16LE(1, 1046);
  bytes.writeUInt32LE(0xd65f03c0, 516);
  const loaded = load(bytes),
    result = discover(loaded);
  const conflict = result.graphs.find(
    (graph) => graph.function.entry.value === loaded.image_base + 512n,
  );
  assert.equal(conflict?.function.boundary, 'conflicting');
  assert.deepEqual(conflict?.instructions, []);
  assert.equal(conflict?.gaps[0]?.reason, 'data');
  const entry = result.graphs.find(
    (graph) => graph.function.entry.value === loaded.entry_points[0]?.value,
  );
  assert.equal(entry?.function.boundary, 'established');
  assert.deepEqual(
    entry?.instructions.map((instruction) => instruction.flow.kind),
    ['return'],
  );
});

for (const path of [
  'macho-arm64-symbols',
  'macho-arm64-stripped',
  'libcorpus-arm64-symbols.dylib',
  'libcorpus-arm64-stripped.dylib',
])
  test(`real ${path} imports through Loader.load`, () => {
    const loaded = load(readFileSync(new URL(`../../../fixtures/bin/${path}`, import.meta.url)));
    assert.equal(loaded.target.architecture, 'arm64');
    assert.ok(loaded.sections.some((section) => section.name === '__text'));
    assert.ok(loaded.hints.some((hint) => hint.kind === 'function'));
    assert.ok(loaded.hints.some((hint) => hint.kind === 'unwind'));
    assert.ok(loaded.relocations.some((relocation) => relocation.kind === 'chained_fixup'));
    assert.equal(
      loaded.diagnostics.filter((diagnostic) => diagnostic.code === 'malformed_image').length,
      0,
    );
    if (path.endsWith('.dylib')) {
      assert.deepEqual(loaded.imports, []);
      assert.equal(loaded.entry_points.length, 0);
      assert.ok(loaded.exports.some((record) => record.original_name === '_fixture_arithmetic'));
    } else {
      assert.equal(loaded.entry_points[0]?.value, 0x100000a8cn);
      assert.ok(
        loaded.imports.some((record) => record.original_name === '_puts' && record.slot !== null),
      );
    }
  });

test('real facts preserve zero-fill overriding file padding, string bytes, function locations, and chained target', () => {
  const loaded = load(fixture),
    va = (value: bigint) => ({ image_id: loaded.id, space: 'va' as const, value });
  assert.equal(loaded.image_base, 0x100000000n);
  const zero = loaded.address_map.translate(va(0x100008008n), 'file');
  assert.equal(zero.kind, 'zero_fill');
  assert.equal(zero.address.space, 'va');
  assert.deepEqual(
    loaded.address_map.spans(va(0x100008000n), 520n).map((span) => [span.kind, span.range.size]),
    [
      ['mapped', 8n],
      ['zero_fill', 512n],
    ],
  );
  const string = loaded.address_map.translate(va(0x100000ad0n), 'file');
  assert.equal(string.kind, 'mapped');
  assert.equal(
    new TextDecoder().decode(loaded.bytes.read(string.address.value, 31)),
    'open-decomp trusted fixture v1\0',
  );
  const fn = loaded.symbols.find((symbol) => symbol.original_name === '_fixture_arithmetic');
  assert.equal(fn?.address?.value, 0x100000574n);
  assert.equal(loaded.address_map.translate(va(0x100000574n), 'file').address.value, 1396n);
  const callback = loaded.relocations.find(
    (record) => record.address.value === 0x100008000n && record.kind === 'chained_fixup',
  );
  assert.equal(callback?.target?.value, 0x100000548n);
  assert.ok(
    loaded.imports.some(
      (record) => record.original_name === '_puts' && record.callable_entry !== null,
    ),
  );
});

test('real universal selection preserves container-relative mappings and every binary proof', () => {
  const bytes = readFileSync(new URL('../../../fixtures/bin/macho-universal', import.meta.url)),
    hash = contentHash(bytes),
    immutable = new ImmutableBytes(bytes),
    id = imageIdentity(hash);
  const inspected = loader.inspect(immutable, id, createOperationContext({}));
  assert.equal(inspected.slices.length, 2);
  const arm = inspected.slices.find((slice) => slice.supported);
  assert.ok(arm);
  assert.equal(arm.offset, 32768n);
  const loaded = load(bytes, arm.id);
  assert.equal(loaded.image_base, 0x100000000n);
  assert.ok(loaded.diagnostics.some((diagnostic) => diagnostic.code === 'unsupported_target'));
  assert.ok(
    loaded.capabilities.some(
      (capability) => capability.layer === 'format' && capability.status === 'supported',
    ),
  );
  assert.equal(
    loaded.capabilities.some((capability) => capability.status === 'partial'),
    false,
  );
  assert.equal(
    loaded.address_map.translate({ image_id: id, space: 'va', value: 0x100000574n }, 'file').address
      .value,
    32768n + 1396n,
  );
  assert.equal(load(bytes).selected_slice_id, arm.id);
  const proofIds = new Set(loaded.evidence.map((proof) => proof.id));
  for (const proof of loaded.evidence)
    if (proof.origin.kind === 'binary') {
      assert.equal(proof.origin.range.start.space, 'file');
      assert.ok(proof.origin.range.start.value >= arm.offset);
      assert.ok(proof.origin.range.start.value + proof.origin.range.size <= arm.offset + arm.size);
    }
  for (const record of [
    ...loaded.symbols,
    ...loaded.imports,
    ...loaded.exports,
    ...loaded.relocations,
    ...loaded.hints,
  ])
    for (const proof of record.evidence_ids) assert.ok(proofIds.has(proof));
});

for (const fat64 of [false, true])
  for (const little of [false, true])
    test(`fat${fat64 ? 64 : 32} ${little ? 'little' : 'big'} endian requires explicit selection for ambiguous ARM64`, () => {
      const bytes = fat(image(), fat64, little),
        hash = contentHash(bytes),
        inspected = loader.inspect(
          new ImmutableBytes(bytes),
          imageIdentity(hash),
          createOperationContext({}),
        );
      assert.throws(
        () => load(bytes),
        (error: unknown) =>
          error instanceof MachOError &&
          error.diagnostic.code === 'ambiguous_slice' &&
          error.diagnostic.details?.kind === 'slice_selection',
      );
      for (const slice of inspected.slices)
        assert.equal(load(bytes, slice.id).selected_slice_id, slice.id);
    });

for (const name of [
  'empty.bin',
  'macho-header-truncated.bin',
  'macho-command-zero.bin',
  'macho-command-overrun.bin',
  'fat-slice-overrun.bin',
])
  test(`malformed fixture ${name} fails explicitly`, () => {
    const bytes = readFileSync(new URL(`../../../fixtures/malformed/${name}`, import.meta.url));
    assert.throws(
      () => load(bytes),
      (error: unknown) =>
        error instanceof MachOError && error.diagnostic.code === 'malformed_image',
    );
  });

test('Mach-O malformed ranges and count limits preserve typed operation failures', () => {
  const overflow = image();
  overflow.writeBigUInt64LE(0xfffffffffffffff0n, 32 + 24);
  const unsafe = image();
  unsafe.writeBigUInt64LE(1n << 53n, 32 + 40);
  const count = Buffer.alloc(32 + 65537 * 8);
  image().copy(count);
  count.writeUInt32LE(65537, 16);
  count.writeUInt32LE(65537 * 8, 20);
  for (const [bytes, code] of [
    [overflow, 'malformed_image'],
    [unsafe, 'malformed_image'],
    [count, 'resource_limit'],
  ] as const) {
    assert.throws(
      () => load(bytes),
      (error: unknown) =>
        error instanceof MachOError &&
        error instanceof OperationError &&
        error.code === code &&
        error.diagnostic.code === code,
    );
  }
});

test('unknown CPU/subtype and object-file inputs remain inspectable but not falsely supported', () => {
  for (const [field, value] of [
    [4, 18],
    [8, 99],
    [12, 1],
  ] as const) {
    const bytes = image();
    bytes.writeUInt32LE(value, field);
    const inspected = loader.inspect(
      new ImmutableBytes(bytes),
      imageIdentity(contentHash(bytes)),
      createOperationContext({}),
    );
    assert.equal(inspected.slices[0]?.supported, false);
    assert.ok(inspected.diagnostics.some((diagnostic) => diagnostic.code === 'unsupported_target'));
    assert.throws(
      () => load(bytes),
      (error: unknown) =>
        error instanceof MachOError && error.diagnostic.code === 'unsupported_target',
    );
  }
});

test('unknown command bytes are retained with unsupported-feature evidence', () => {
  const extra = command(0x80001234, 16);
  extra.writeUInt32LE(0x12345678, 8);
  const loaded = load(image([extra])),
    header = loaded.headers.find((record) => record.name === 'LC_UNKNOWN_0x80001234');
  assert.ok(
    header?.fields.some(
      (field) => field.kind === 'integer' && field.name === 'word_8' && field.value === 0x12345678n,
    ),
  );
  assert.ok(
    loaded.diagnostics.some(
      (diagnostic) => diagnostic.code === 'unsupported_target' && diagnostic.evidence_ids.length,
    ),
  );
});

test('invalid segment/section ranges and overlap are rejected rather than chosen by order', () => {
  const outside = image();
  outside.writeBigUInt64LE(0xffffffffffffffffn, 32 + 32);
  assert.throws(() => load(outside), MachOError);
  const disagree = image();
  disagree.writeUInt32LE(516, 32 + 72 + 48);
  assert.throws(() => load(disagree), MachOError);
  const duplicateSegment = command(25, 72);
  duplicateSegment.write('__ALIAS', 8);
  duplicateSegment.writeBigUInt64LE(0x100000000n, 24);
  duplicateSegment.writeBigUInt64LE(16n, 32);
  duplicateSegment.writeBigUInt64LE(16n, 48);
  assert.throws(() => load(image([duplicateSegment])), MachOError);
  const tableDisagreement = fat(image());
  tableDisagreement.writeUInt32BE(2, 12);
  assert.throws(() => load(tableDisagreement), MachOError);
});

test('function starts and executable data-in-code remain distinct with byte evidence', () => {
  const bytes = image([linkedit(38, 1024, 3), linkedit(41, 1040, 8)]);
  bytes.set([0x80, 4, 0], 1024);
  bytes.writeUInt32LE(516, 1040);
  bytes.writeUInt16LE(4, 1044);
  bytes.writeUInt16LE(1, 1046);
  const loaded = load(bytes);
  assert.ok(
    loaded.hints.some((hint) => hint.kind === 'function' && hint.address.value === 0x100000200n),
  );
  assert.ok(
    loaded.hints.some(
      (hint) =>
        hint.kind === 'data' &&
        hint.range.start.value === 0x100000204n &&
        hint.range.size === 4n &&
        hint.encoding === 'bytes',
    ),
  );
  const bad = Buffer.from(bytes);
  bad.fill(0x80, 1024, 1027);
  assert.ok(load(bad).diagnostics.some((diagnostic) => diagnostic.code === 'malformed_image'));
});

test('export trie handles normal addresses, split UTF-8 edges, and cycles without recursion', () => {
  const normal = Buffer.from([0, 1, ...Buffer.from('_entry\0'), 10, 3, 0, 0x80, 4, 0]);
  const bytes = image([linkedit(0x80000033, 1024, normal.length)]);
  normal.copy(bytes, 1024);
  assert.equal(
    load(bytes).exports.find((record) => record.original_name === '_entry')?.address?.value,
    0x100000200n,
  );
  const utf8 = Buffer.from([0, 1, 0xc3, 0, 5, 0, 1, 0xa9, 0, 10, 3, 0, 0x80, 4, 0]);
  const unicode = image([linkedit(0x80000033, 1024, utf8.length)]);
  utf8.copy(unicode, 1024);
  assert.ok(load(unicode).exports.some((record) => record.original_name === 'é'));
  const cycle = Buffer.from([0, 1, 65, 0, 0]),
    cyclic = image([linkedit(0x80000033, 1024, cycle.length)]);
  cycle.copy(cyclic, 1024);
  assert.ok(
    load(cyclic).diagnostics.some(
      (diagnostic) => diagnostic.code === 'malformed_image' && diagnostic.message.includes('cycle'),
    ),
  );
});

test('classic bind/rebase streams expose pointer slots, addends, and targets', () => {
  const dyld = command(0x80000022, 48);
  dyld.writeUInt32LE(1024, 8);
  dyld.writeUInt32LE(5, 12);
  dyld.writeUInt32LE(1040, 16);
  const bind = Buffer.from([
    0x30,
    0x40,
    ...Buffer.from('_external\0'),
    0x60,
    0x7f,
    0x70,
    0x88,
    6,
    0x90,
    0,
  ]);
  dyld.writeUInt32LE(bind.length, 20);
  const bytes = image([dyld]);
  bytes.set([0x20, 0x80, 6, 0x51, 0], 1024);
  bind.copy(bytes, 1040);
  bytes.writeBigUInt64LE(0x100000200n, 768);
  const loaded = load(bytes);
  assert.ok(
    loaded.relocations.some(
      (record) =>
        record.kind === 'rebase' &&
        record.address.value === 0x100000300n &&
        record.target?.value === 0x100000200n,
    ),
  );
  assert.ok(
    loaded.relocations.some(
      (record) =>
        record.kind === 'bind' && record.address.value === 0x100000308n && record.addend === -1n,
    ),
  );
  assert.ok(
    loaded.imports.some(
      (record) =>
        record.original_name === '_external' &&
        record.slot?.value === 0x100000308n &&
        record.callable_entry === null,
    ),
  );
});

test('classic stream bad slots and unknown opcodes remain explicit', () => {
  const dyld = command(0x80000022, 48);
  dyld.writeUInt32LE(1024, 8);
  dyld.writeUInt32LE(5, 12);
  const bytes = image([dyld]);
  bytes.set([0x2f, 0, 0x51, 0, 0], 1024);
  assert.ok(load(bytes).diagnostics.some((diagnostic) => diagnostic.code === 'malformed_image'));
  bytes.set([0xf0, 0, 0, 0, 0], 1024);
  assert.ok(load(bytes).diagnostics.some((diagnostic) => diagnostic.code === 'unsupported_target'));
});

test('actual context cancellation and work bounds escape optional metadata recovery', () => {
  const hash = contentHash(fixture),
    input = {
      image_id: imageIdentity(hash),
      sha256: hash,
      bytes: new ImmutableBytes(fixture),
      slice_id: null,
    };
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => loader.load(input, createOperationContext({ signal: controller.signal })));
  assert.throws(() => loader.load(input, createOperationContext({ budget: { work: 1 } })));
});

test('chained userland pointer formats preserve static targets and authentication', () => {
  for (const format of [1, 2, 6, 9, 12]) {
    const bytes = image([linkedit(0x80000034, 1024, 60)]),
      p = 1024;
    bytes.writeUInt32LE(28, p + 4);
    bytes.writeUInt32LE(60, p + 8);
    bytes.writeUInt32LE(60, p + 12);
    bytes.writeUInt32LE(1, p + 28);
    bytes.writeUInt32LE(8, p + 32);
    bytes.writeUInt32LE(24, p + 36);
    bytes.writeUInt16LE(4096, p + 40);
    bytes.writeUInt16LE(format, p + 42);
    bytes.writeUInt16LE(1, p + 56);
    bytes.writeUInt16LE(768, p + 58);
    const authenticated = format === 12;
    const word =
      (format === 1 || format === 2 ? 0x100000200n : 0x200n) | (authenticated ? 1n << 63n : 0n);
    bytes.writeBigUInt64LE(word, 768);
    const loaded = load(bytes),
      relocation = loaded.relocations.find((record) => record.kind === 'chained_fixup');
    assert.equal(relocation?.address.value, 0x100000300n, `format ${format}`);
    assert.equal(relocation?.target?.value, 0x100000200n, `format ${format}`);
    assert.equal(relocation?.authenticated, authenticated);
    assert.equal(loaded.diagnostics.length, 0);
    bytes.writeUInt16LE(13, p + 42);
    assert.ok(load(bytes).diagnostics.some((record) => record.code === 'unsupported_target'));
  }
});

test('chained binding imports distinguish pointer storage and retain inline addends', () => {
  const bytes = image([linkedit(0x80000034, 1024, 74)]),
    p = 1024;
  bytes.writeUInt32LE(28, p + 4);
  bytes.writeUInt32LE(60, p + 8);
  bytes.writeUInt32LE(64, p + 12);
  bytes.writeUInt32LE(1, p + 16);
  bytes.writeUInt32LE(1, p + 20);
  bytes.writeUInt32LE(1, p + 28);
  bytes.writeUInt32LE(8, p + 32);
  bytes.writeUInt32LE(24, p + 36);
  bytes.writeUInt16LE(4096, p + 40);
  bytes.writeUInt16LE(6, p + 42);
  bytes.writeUInt16LE(1, p + 56);
  bytes.writeUInt16LE(768, p + 58);
  bytes.write('_external\0', p + 64);
  bytes.writeBigUInt64LE((1n << 63n) | (5n << 24n), 768);
  const loaded = load(bytes),
    imported = loaded.imports.find((record) => record.original_name === '_external');
  assert.ok(imported);
  assert.equal(imported?.slot?.value, 0x100000300n);
  assert.equal(imported.callable_entry, null);
  assert.equal(loaded.relocations.find((record) => record.symbol_id === imported.id)?.addend, 5n);
  bytes.writeBigUInt64LE((1n << 63n) | 2n, 768);
  assert.ok(load(bytes).diagnostics.some((record) => record.code === 'malformed_image'));
});

test('compact unwind regular and compressed pages supply bounded function ranges', () => {
  for (const compressed of [false, true]) {
    const bytes = image(),
      p = 512;
    bytes.fill(0, 32 + 72, 32 + 72 + 16);
    bytes.write('__unwind_info', 32 + 72);
    bytes.writeUInt32LE(1, p);
    bytes.writeUInt32LE(28, p + 4);
    bytes.writeUInt32LE(1, p + 8);
    bytes.writeUInt32LE(32, p + 12);
    bytes.writeUInt32LE(32, p + 20);
    bytes.writeUInt32LE(2, p + 24);
    bytes.writeUInt32LE(0x02000000, p + 28);
    bytes.writeUInt32LE(0x300, p + 32);
    bytes.writeUInt32LE(64, p + 36);
    bytes.writeUInt32LE(56, p + 40);
    bytes.writeUInt32LE(0x320, p + 44);
    bytes.writeUInt32LE(56, p + 52);
    bytes.writeUInt32LE(compressed ? 3 : 2, p + 64);
    bytes.writeUInt16LE(compressed ? 12 : 8, p + 68);
    bytes.writeUInt16LE(1, p + 70);
    if (compressed) {
      bytes.writeUInt16LE(16, p + 72);
      bytes.writeUInt32LE(0, p + 76);
    } else {
      bytes.writeUInt32LE(0x300, p + 72);
      bytes.writeUInt32LE(0x02000000, p + 76);
    }
    const loaded = load(bytes),
      hint = loaded.hints.find((record) => record.kind === 'unwind');
    assert.equal(hint?.kind, 'unwind');
    if (hint?.kind !== 'unwind') assert.fail('Missing unwind range');
    assert.equal(hint.range.start.value, 0x100000300n);
    assert.equal(hint.range.size, 32n);
    assert.equal(hint.record.start.space, 'file');
    bytes.writeUInt32LE(0x200, p + 44);
    assert.ok(load(bytes).diagnostics.some((record) => record.code === 'malformed_image'));
  }
});

test('section relocation records retain type, width, signed addend and evidence', () => {
  const bytes = image();
  bytes.writeUInt32LE(1024, 32 + 72 + 56);
  bytes.writeUInt32LE(2, 32 + 72 + 60);
  bytes.writeUInt32LE(0, 1024);
  bytes.writeUInt32LE(0x04000001, 1028);
  bytes.writeUInt32LE(4, 1032);
  bytes.writeUInt32LE(0xa4ffffff, 1036);
  const loaded = load(bytes);
  assert.equal(loaded.relocations[0]?.target?.value, 0x100000200n);
  assert.equal(loaded.relocations[0]?.width_bits, 32);
  assert.equal(loaded.relocations[1]?.addend, -1n);
  assert.equal(loaded.relocations[1]?.encoding, 'ARM64_RELOC_10');
});

test('encrypted instruction ranges are preserved as data boundaries, never function-start seeds', () => {
  const encryption = command(44, 24);
  encryption.writeUInt32LE(512, 8);
  encryption.writeUInt32LE(4, 12);
  encryption.writeUInt32LE(1, 16);
  const bytes = image([encryption, linkedit(38, 1024, 3)]);
  bytes.set([0x80, 4, 0], 1024);
  const loaded = load(bytes);
  assert.ok(
    loaded.hints.some(
      (record) =>
        record.kind === 'data' &&
        record.range.start.value === 0x100000200n &&
        record.range.size === 4n,
    ),
  );
  assert.equal(
    loaded.hints.some((record) => record.kind === 'function'),
    false,
  );
  assert.ok(loaded.diagnostics.some((record) => record.code === 'unsupported_target'));
});

test('raw compact-unwind records preserve complete headers and function ranges', () => {
  const bytes = image(),
    section = 32 + 72;
  bytes.fill(0, section, section + 16);
  bytes.write('__compact_unwind', section);
  bytes.writeBigUInt64LE(32n, section + 40);
  bytes.fill(0, 512, 544);
  bytes.writeBigUInt64LE(0x100000300n, 512);
  bytes.writeUInt32LE(16, 520);
  bytes.writeUInt32LE(0x02000000, 524);
  const loaded = load(bytes),
    hint = loaded.hints.find((record) => record.kind === 'unwind');
  assert.ok(hint && hint.kind === 'unwind');
  assert.equal(hint.range.start.value, 0x100000300n);
  assert.equal(hint.range.size, 16n);
  assert.ok(
    loaded.headers.some(
      (record) => record.name === 'compact_unwind_entry_64' && record.range.start.value === 512n,
    ),
  );
});

test('chained offsets, page starts, and payload tables cannot escape their bounds', () => {
  const bytes = image([linkedit(0x80000034, 1024, 60)]),
    p = 1024;
  bytes.writeUInt32LE(28, p + 4);
  bytes.writeUInt32LE(60, p + 8);
  bytes.writeUInt32LE(60, p + 12);
  bytes.writeUInt32LE(1, p + 28);
  bytes.writeUInt32LE(8, p + 32);
  bytes.writeUInt32LE(24, p + 36);
  bytes.writeUInt16LE(4096, p + 40);
  bytes.writeUInt16LE(6, p + 42);
  bytes.writeUInt16LE(1, p + 56);
  for (const start of [4092, 0x8000]) {
    bytes.writeUInt16LE(start, p + 58);
    assert.ok(load(bytes).diagnostics.some((record) => record.code === 'malformed_image'));
  }
  bytes.writeUInt32LE(0xfffffff0, p + 4);
  assert.ok(load(bytes).diagnostics.some((record) => record.code === 'malformed_image'));
});

test('native symbol-table completeness is reported independently of unrelated optional metadata', () => {
  const tables = (loaded: LoadedImage) =>
    loaded.capabilities.find((capability) => capability.feature === NATIVE_SYMBOL_TABLES_FEATURE);
  assert.equal(tables(load(fixture))?.status, 'supported');
  // An unterminated function-start stream degrades the format capability, not the symbol tables.
  const starts = command(0x26, 16);
  starts.writeUInt32LE(0x800, 8);
  starts.writeUInt32LE(4, 12);
  const unrelatedBytes = image([starts]);
  unrelatedBytes.fill(0xff, 0x800, 0x804);
  const unrelated = load(unrelatedBytes);
  assert.equal(
    unrelated.capabilities.find((capability) => capability.feature.startsWith('Mach-O'))?.status,
    'partial',
  );
  assert.ok(unrelated.diagnostics.some((diagnostic) => diagnostic.message.startsWith('Function starts:')));
  assert.equal(tables(unrelated)?.status, 'supported');
  assert.deepEqual(tables(unrelated)?.limitations, []);
  // A symbol whose name lies outside the string table makes name authority partial, with the reason.
  const symtab = command(2, 24);
  symtab.writeUInt32LE(0x900, 8);
  symtab.writeUInt32LE(1, 12);
  symtab.writeUInt32LE(0xa00, 16);
  symtab.writeUInt32LE(16, 20);
  const brokenBytes = image([symtab]);
  brokenBytes.writeUInt32LE(0x1000, 0x900);
  brokenBytes[0x904] = 0x0f;
  brokenBytes[0x905] = 1;
  const broken = load(brokenBytes);
  assert.equal(tables(broken)?.status, 'partial');
  assert.ok(tables(broken)!.limitations.length > 0);
});
