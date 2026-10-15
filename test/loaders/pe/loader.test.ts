// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  ImmutableBytes, OperationError, contentHash, createOperationContext, imageIdentity,
  type LoadedImage,
} from '../../../src/core/index.js';
import { PELoader, PELoadError } from '../../../src/loaders/pe/index.js';

function load(bytes: Uint8Array, ctx = createOperationContext()): LoadedImage {
  const sha256 = contentHash(bytes);
  return new PELoader().load({ bytes: new ImmutableBytes(bytes), image_id: imageIdentity(sha256), sha256, slice_id: null }, ctx);
}
const fixture = (name: string): Buffer => readFileSync(new URL(`../../../fixtures/bin/${name}`, import.meta.url));
const malformed = (name: string): Buffer => readFileSync(new URL(`../../../fixtures/malformed/${name}`, import.meta.url));
const BASE = 0x180000000n;
const OPTIONAL = 0x98;
const SECTION = OPTIONAL + 240;
/** Test-local field builder, not a second parser or a target-executed program. */
function boundaryImage(): Buffer {
  const b = Buffer.alloc(0x2000);
  b.writeUInt16LE(0x5a4d, 0); b.writeUInt32LE(0x80, 0x3c); b.writeUInt32LE(0x4550, 0x80);
  b.writeUInt16LE(0x8664, 0x84); b.writeUInt16LE(1, 0x86); b.writeUInt16LE(240, 0x94); b.writeUInt16LE(0x2022, 0x96);
  b.writeUInt16LE(0x20b, OPTIONAL); b.writeBigUInt64LE(BASE, OPTIONAL + 24);
  b.writeUInt32LE(0x1000, OPTIONAL + 32); b.writeUInt32LE(0x200, OPTIONAL + 36);
  b.writeUInt32LE(0x4000, OPTIONAL + 56); b.writeUInt32LE(0x400, OPTIONAL + 60); b.writeUInt16LE(3, OPTIONAL + 68); b.writeUInt32LE(16, OPTIONAL + 108);
  b.write('.all', SECTION); b.writeUInt32LE(0x3000, SECTION + 8); b.writeUInt32LE(0x1000, SECTION + 12);
  b.writeUInt32LE(0x1c00, SECTION + 16); b.writeUInt32LE(0x400, SECTION + 20); b.writeUInt32LE(0xe0000060, SECTION + 36);
  return b;
}
function putDirectory(b: Buffer, index: number, rva: number, size: number): void {
  b.writeUInt32LE(rva, OPTIONAL + 112 + index * 8); b.writeUInt32LE(size, OPTIONAL + 116 + index * 8);
}
function file(rva: number): number { return rva - 0x1000 + 0x400; }
function failure(bytes: Buffer, code: PELoadError['diagnostic']['code'] = 'malformed_image'): void {
  assert.throws(() => load(bytes), (error: unknown) => error instanceof PELoadError && error.diagnostic.code === code);
}

for (const name of ['corpus-symbols.dll', 'corpus-stripped.dll', 'pe-x86_64-symbols.exe', 'pe-x86_64-stripped.exe']) {
  test(`real compiler image ${name} loads statically`, () => {
    const image = load(fixture(name));
    assert.equal(image.target.architecture, 'x86_64'); assert.equal(image.target.abi, 'windows-x64');
    assert.equal(image.slices.length, 1); assert.ok(image.slices[0]?.supported);
    assert.ok(image.headers.some(h => h.kind === 'dos_header'));
    assert.ok(image.headers.some(h => h.kind === 'data_directory'));
    assert.ok(image.hints.some(h => h.kind === 'unwind'));
    assert.ok(image.evidence.length > 0);
    for (const section of image.sections) {
      if (!section.file_range?.size) continue;
      const translation = image.address_map.translate(section.virtual_range.start, 'file');
      assert.equal(translation.kind, 'mapped'); assert.equal(translation.address.value, section.file_range.start.value);
    }
    if (name.endsWith('.exe')) {
      assert.equal(image.image_base, 0x140000000n);
      assert.deepEqual(image.entry_points.map(e => e.value), [0x140001000n]);
      assert.deepEqual(image.imports.map(i => `${i.library}!${i.original_name}`).sort(), ['KERNEL32.dll!ExitProcess', 'corpus-symbols.dll!fixture_check'].sort());
      assert.ok(image.imports.every(i => i.slot?.space === 'va' && i.callable_entry === null));
    } else {
      assert.equal(image.image_base, BASE); assert.deepEqual(image.entry_points, []);
      assert.equal(image.exports.find(e => e.original_name === 'fixture_stack')?.address?.value, BASE + 0x1000n);
      assert.equal(image.exports.find(e => e.original_name === 'fixture_callback')?.address?.value, BASE + 0x3000n);
      assert.equal(image.exports.find(e => e.original_name === 'fixture_zero_fill')?.address?.value, BASE + 0x3010n);
      assert.equal(image.exports.length, 19);
      const translation = image.address_map.translate({ image_id: image.id, space: 'rva', value: 0x3000n }, 'file');
      assert.equal(translation.address.value, 4096n);
      assert.equal(image.address_map.translate({ image_id: image.id, space: 'rva', value: 0x3200n }, 'file').kind, 'zero_fill');
      assert.equal(image.address_map.translate({ image_id: image.id, space: 'rva', value: 0x3214n }, 'file').kind, 'unmapped');
      const relocation = image.relocations.find(r => r.address.value === BASE + 0x3000n);
      assert.ok(relocation); assert.equal(relocation.encoding, 'IMAGE_REL_BASED_DIR64'); assert.equal(relocation.target?.value, BASE + 0x1000n);
      const unwind = image.hints.find(h => h.kind === 'unwind' && h.range.start.value === BASE + 0x1000n);
      assert.ok(unwind?.kind === 'unwind'); assert.equal(unwind.range.size, 0x27n); assert.equal(unwind.record.start.space, 'file'); assert.equal(unwind.record.start.value, 0xf38n);
      const codeview = image.headers.find(h => h.kind === 'debug_record');
      assert.ok(codeview?.fields.some(f => f.kind === 'integer' && f.name === 'CodeViewSignature' && f.value === 0n));
      assert.ok(image.diagnostics.some(d => d.code === 'unsupported_target' && d.address?.value === 0xcf4n));
      assert.ok(!codeview?.fields.some(f => f.name === 'PdbGuidBytes'));
      if (name.includes('symbols')) {
        assert.ok(image.sections.some(s => s.name === '.debug_info'));
        assert.equal(image.symbols.find(s => s.original_name === 'fixture_stack')?.address?.value, BASE + 0x1000n);
      }
    }
  });
}

test('header and RVA/file/VA distinctions and partial backed/zero-fill spans are consumer visible', () => {
  const image = load(boundaryImage());
  const offset = image.address_map.translate({ image_id: image.id, space: 'va', value: BASE + 0x1000n }, 'file');
  assert.equal(offset.kind, 'mapped'); assert.equal(offset.address.value, 0x400n);
  const spans = image.address_map.spans({ image_id: image.id, space: 'rva', value: 0x2bf8n }, 16n);
  assert.deepEqual(spans.map(s => [s.kind, s.range.size, s.file_offset]), [['mapped', 8n, 0x1ff8n], ['zero_fill', 8n, null]]);
  assert.equal(image.address_map.translate({ image_id: image.id, space: 'file', value: 0x3cn }, 'va').address.value, BASE + 0x3cn);
});

test('ordinary imports by name and ordinal retain pointer slots without inventing callable entries', () => {
  const b = boundaryImage(); putDirectory(b, 1, 0x1100, 40);
  b.writeUInt32LE(0x1200, file(0x1100)); b.writeUInt32LE(0x1300, file(0x1100) + 12); b.writeUInt32LE(0x1250, file(0x1100) + 16);
  b.write('example.dll\0', file(0x1300)); b.writeBigUInt64LE(0x1400n, file(0x1200)); b.writeBigUInt64LE((1n << 63n) | 42n, file(0x1208));
  b.writeUInt16LE(7, file(0x1400)); b.write('function_name\0', file(0x1402));
  const image = load(b);
  assert.equal(image.imports.length, 2);
  assert.equal(image.imports[0]?.original_name, 'function_name'); assert.equal(image.imports[0]?.ordinal, null);
  assert.equal(image.imports[0]?.slot?.value, BASE + 0x1250n); assert.equal(image.imports[1]?.ordinal, 42);
  assert.equal(image.imports[1]?.original_name, null); assert.ok(image.imports.every(i => i.callable_entry === null && !i.delayed));
  // OriginalFirstThunk may be absent in an unbound image.
  b.writeUInt32LE(0, file(0x1100)); b.copy(b, file(0x1250), file(0x1200), file(0x1218));
  assert.equal(load(b).imports[1]?.ordinal, 42);
});

test('delay imports use descriptor address mode and retain delayed ordinal/name imports', () => {
  for (const rvaMode of [true, false]) {
    const b = boundaryImage();
    const base = rvaMode ? BASE : 0x10000000n;
    b.writeBigUInt64LE(base, OPTIONAL + 24);
    putDirectory(b, 13, 0x1100, 64);
    const pointer = (rva: number): number => rvaMode ? rva : Number(base) + rva;
    b.writeUInt32LE(rvaMode ? 1 : 0, file(0x1100)); b.writeUInt32LE(pointer(0x1300), file(0x1100) + 4);
    b.writeUInt32LE(pointer(0x1250), file(0x1100) + 12); b.writeUInt32LE(pointer(0x1200), file(0x1100) + 16);
    b.write('delayed.dll\0', file(0x1300)); b.writeBigUInt64LE(BigInt(pointer(0x1400)), file(0x1200)); b.writeBigUInt64LE((1n << 63n) | 9n, file(0x1208)); b.write('DelayedFunction\0', file(0x1402));
    const image = load(b);
    assert.equal(image.imports.length, 2); assert.ok(image.imports.every(i => i.delayed));
    assert.equal(image.imports[0]?.original_name, 'DelayedFunction'); assert.equal(image.imports[0]?.slot?.value, base + 0x1250n); assert.equal(image.imports[1]?.ordinal, 9);
  }
});

test('exports preserve aliases, ordinal-only entries, holes and forwarders', () => {
  const b = boundaryImage(); putDirectory(b, 0, 0x1100, 0x100);
  b.writeUInt32LE(10, file(0x1100) + 16); b.writeUInt32LE(4, file(0x1100) + 20); b.writeUInt32LE(2, file(0x1100) + 24);
  b.writeUInt32LE(0x1300, file(0x1100) + 28); b.writeUInt32LE(0x1320, file(0x1100) + 32); b.writeUInt32LE(0x1340, file(0x1100) + 36);
  b.writeUInt32LE(0x1500, file(0x1300)); b.writeUInt32LE(0x1180, file(0x1304)); b.writeUInt32LE(0x1510, file(0x130c));
  b.write('KERNEL32.#12\0', file(0x1180)); b.writeUInt32LE(0x1360, file(0x1320)); b.writeUInt32LE(0x1370, file(0x1324));
  b.write('AliasA\0', file(0x1360)); b.write('AliasB\0', file(0x1370));
  const image = load(b);
  assert.equal(image.exports.length, 4);
  assert.deepEqual(image.exports.filter(e => e.ordinal === 10).map(e => e.original_name), ['AliasA', 'AliasB']);
  assert.deepEqual(image.exports.find(e => e.ordinal === 11)?.forwarder, { library: 'KERNEL32', symbol: '#12' });
  assert.equal(image.exports.find(e => e.ordinal === 11)?.address, null);
  assert.equal(image.exports.find(e => e.ordinal === 13)?.original_name, null);
  assert.equal(image.exports.find(e => e.ordinal === 13)?.address?.value, BASE + 0x1510n);
  assert.ok(!image.exports.some(e => e.ordinal === 12));
});

test('relocations and unwind handler/chained records retain actual file evidence', () => {
  const b = boundaryImage(); putDirectory(b, 5, 0x1100, 12);
  b.writeUInt32LE(0x1000, file(0x1100)); b.writeUInt32LE(12, file(0x1104)); b.writeUInt16LE(0xa700, file(0x1108)); b.writeBigUInt64LE(BASE + 0x1800n, file(0x1700));
  putDirectory(b, 3, 0x1200, 12);
  b.writeUInt32LE(0x1800, file(0x1200)); b.writeUInt32LE(0x1840, file(0x1204)); b.writeUInt32LE(0x1300, file(0x1208));
  b[file(0x1300)] = 1 | (4 << 3); b.writeUInt32LE(0x1800, file(0x1304)); b.writeUInt32LE(0x1840, file(0x1308)); b.writeUInt32LE(0x1400, file(0x130c));
  b[file(0x1400)] = 1 | (1 << 3); b.writeUInt32LE(0x1900, file(0x1404));
  const image = load(b);
  assert.equal(image.relocations[0]?.address.value, BASE + 0x1700n); assert.equal(image.relocations[0]?.target?.value, BASE + 0x1800n);
  const unwind = image.hints.filter(h => h.kind === 'unwind'); assert.equal(unwind.length, 2);
  assert.equal(unwind[0]?.record.start.value, BigInt(file(0x1300))); assert.equal(unwind[1]?.handler?.value, BASE + 0x1900n);
  assert.ok(image.capabilities.some(c => c.feature === 'unwind:language-handler' && c.status === 'unsupported'));
});

test('TLS template and callback VA references are not interpreted as RVAs', () => {
  const b = boundaryImage(); putDirectory(b, 9, 0x1100, 40);
  b.writeBigUInt64LE(BASE + 0x1300n, file(0x1100)); b.writeBigUInt64LE(BASE + 0x1310n, file(0x1108)); b.writeBigUInt64LE(BASE + 0x1400n, file(0x1110)); b.writeBigUInt64LE(BASE + 0x1500n, file(0x1118)); b.writeUInt32LE(32, file(0x1120));
  b.writeBigUInt64LE(BASE + 0x1600n, file(0x1500));
  const image = load(b);
  assert.deepEqual(image.entry_points.map(e => e.value), [BASE + 0x1600n]);
  assert.ok(image.hints.some(h => h.kind === 'data' && h.range.start.value === BASE + 0x1300n && h.range.size === 16n));
  const header = image.headers.find(h => h.kind === 'tls_record');
  assert.ok(header?.fields.some(f => f.kind === 'integer' && f.name === 'SizeOfZeroFill' && f.value === 32n));
});

test('RSDS debug references expose GUID bytes/age/path without opening the PDB', () => {
  const b = boundaryImage(); putDirectory(b, 6, 0x1100, 28);
  b.writeUInt32LE(2, file(0x1100) + 12); b.writeUInt32LE(64, file(0x1100) + 16); b.writeUInt32LE(0x1200, file(0x1100) + 20); b.writeUInt32LE(file(0x1200), file(0x1100) + 24);
  b.write('RSDS', file(0x1200)); b.fill(0xab, file(0x1204), file(0x1214)); b.writeUInt32LE(3, file(0x1214)); b.write('C:\\missing\\not-opened.pdb\0', file(0x1218));
  const image = load(b), fields = image.headers.find(h => h.kind === 'debug_record')?.fields;
  assert.ok(fields?.some(f => f.kind === 'text' && f.name === 'PdbGuidBytes' && f.value === 'ab'.repeat(16)));
  assert.ok(fields?.some(f => f.kind === 'integer' && f.name === 'PdbAge' && f.value === 3n));
  assert.ok(fields?.some(f => f.kind === 'text' && f.name === 'PdbPath' && f.value === 'C:\\missing\\not-opened.pdb'));
  b.writeUInt32LE(file(0x1210), file(0x1100) + 24); failure(b);
});

for (const name of ['pe-dos-truncated.bin', 'pe-header-overrun.bin', 'pe-section-overrun.bin', 'pe-directory-overrun.bin']) {
  test(`malformed fixture ${name} fails explicitly`, () => failure(malformed(name)));
}
test('unsupported machine and managed images cannot masquerade as native empty images', () => {
  failure(malformed('pe-unsupported-machine.bin'), 'unsupported_target');
  const b = boundaryImage(); putDirectory(b, 14, 0x1100, 72);
  const bytes = new ImmutableBytes(b), image = imageIdentity(contentHash(b));
  const inspected = new PELoader().inspect(bytes, image, createOperationContext());
  assert.equal(inspected.slices[0]?.supported, false); assert.equal(inspected.diagnostics[0]?.code, 'unsupported_target');
  failure(b, 'unsupported_target');
});

test('adversarial headers/directories reject overflow, overlap, unbacked data and forged counts', () => {
  const mutations: ((b: Buffer) => void)[] = [
    b => b.writeUInt16LE(97, 0x86),
    b => b.writeUInt32LE(0xffffffff, OPTIONAL + 108),
    b => b.writeUInt32LE(0x80, OPTIONAL + 60),
    b => b.writeBigUInt64LE(0xffffffffffff0000n, OPTIONAL + 24), // valid base; enlarge image to overflow below
    b => b.writeUInt32LE(0x0000, SECTION + 12),
    b => b.writeUInt32LE(0x0200, SECTION + 20),
    b => putDirectory(b, 1, 0x2ff0, 40),
    b => putDirectory(b, 1, 0, 40),
    b => putDirectory(b, 1, 0x1100, 0),
    b => { putDirectory(b, 0, 0x1100, 40); b.writeUInt32LE(0xffffffff, file(0x1100) + 20); },
    b => { putDirectory(b, 5, 0x1100, 8); b.writeUInt32LE(0, file(0x1104)); },
    b => putDirectory(b, 3, 0x1100, 11),
    b => putDirectory(b, 6, 0x1100, 27),
    b => putDirectory(b, 9, 0x1100, 39),
  ];
  for (const [i, mutation] of mutations.entries()) {
    const b = boundaryImage(); mutation(b);
    if (i === 3) b.writeUInt32LE(0x20000, OPTIONAL + 56);
    assert.throws(() => load(b), PELoadError, `mutation ${i}`);
  }
});

test('unterminated import tables/strings and invalid ordinal bits fail rather than appear empty', () => {
  const b = boundaryImage(); putDirectory(b, 1, 0x1100, 20);
  b.writeUInt32LE(0x1200, file(0x1100)); b.writeUInt32LE(0x1300, file(0x1100) + 12); b.writeUInt32LE(0x1250, file(0x1100) + 16); b.write('x.dll\0', file(0x1300));
  failure(b); // no null descriptor, even though thunk table is empty
  putDirectory(b, 1, 0x1100, 40); b.writeBigUInt64LE((1n << 63n) | 0x10000n, file(0x1200)); failure(b);
  b.writeBigUInt64LE(0n, file(0x1200)); b.writeUInt32LE(0x2bff, file(0x1100) + 12); b[0x1fff] = 65; failure(b);
});

test('unwind chain cycles and code operands outside CountOfCodes fail safely', () => {
  const b = boundaryImage(); putDirectory(b, 3, 0x1100, 12);
  b.writeUInt32LE(0x1800, file(0x1100)); b.writeUInt32LE(0x1840, file(0x1104)); b.writeUInt32LE(0x1200, file(0x1108));
  b[file(0x1200)] = 0x21; b.writeUInt32LE(0x1800, file(0x1204)); b.writeUInt32LE(0x1840, file(0x1208)); b.writeUInt32LE(0x1200, file(0x120c)); failure(b);
  b[file(0x1200)] = 1; b[file(0x1201)] = 8; b[file(0x1202)] = 1; b[file(0x1204)] = 4; b[file(0x1205)] = 1; failure(b);
  b[file(0x1200)] = 2;
  const image = load(b);
  assert.ok(image.capabilities.some(c => c.feature === 'unwind:version:2' && c.status === 'unsupported'));
  assert.equal(image.hints.filter(h => h.kind === 'unwind').length, 0);
});

test('work exhaustion, cancellation and foreign slice selections stay typed', () => {
  const bytes = boundaryImage(); assert.throws(() => load(bytes, createOperationContext({ budget: { work: 3 } })), (e: unknown) => e instanceof OperationError && e.diagnostic.code === 'resource_limit');
  const controller = new AbortController(); controller.abort();
  assert.throws(() => load(bytes, createOperationContext({ signal: controller.signal })), (e: unknown) => e instanceof OperationError && e.diagnostic.code === 'cancelled');
  const sha256 = contentHash(bytes);
  assert.throws(() => new PELoader().load({ bytes: new ImmutableBytes(bytes), image_id: imageIdentity(sha256), sha256, slice_id: `slice_${'0'.repeat(64)}` }, createOperationContext()), (e: unknown) => e instanceof PELoadError && e.diagnostic.code === 'invalid_input');
});
