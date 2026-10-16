// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ImmutableBytes, OperationError, contentHash, createOperationContext, imageIdentity, type LoadedImage } from '../../../src/core/index.js';
import { ELFLoader, ELFLoadError } from '../../../src/loaders/elf/index.js';
import { discoverFunctions } from '../../../src/analysis/discovery/index.js';
import { X86Decoder } from '../../../src/decoders/x86_64/index.js';

const BASE = 0x400000n, SHOFF = 0x1000;
function load(bytes: Uint8Array, context = createOperationContext()): LoadedImage {
  const sha256 = contentHash(bytes);
  return new ELFLoader().load({ bytes: new ImmutableBytes(bytes), image_id: imageIdentity(sha256), sha256, slice_id: null }, context);
}
function failure(bytes: Uint8Array, code: ELFLoadError['diagnostic']['code'] = 'malformed_image'): void {
  assert.throws(() => load(bytes), (error: unknown) => error instanceof ELFLoadError && error.code === code);
}
/** Field builder only: no independent parser and no target-executed program. */
function boundaryImage(versions = false): Buffer {
  const b = Buffer.alloc(0x2000);
  b.writeUInt32LE(0x464c457f, 0); b[4] = 2; b[5] = 1; b[6] = 1;
  b.writeUInt16LE(2, 16); b.writeUInt16LE(62, 18); b.writeUInt32LE(1, 20);
  b.writeBigUInt64LE(BASE + 0x200n, 24); b.writeBigUInt64LE(64n, 32); b.writeBigUInt64LE(BigInt(SHOFF), 40);
  b.writeUInt16LE(64, 52); b.writeUInt16LE(56, 54); b.writeUInt16LE(2, 56); b.writeUInt16LE(64, 58); b.writeUInt16LE(versions ? 11 : 9, 60); b.writeUInt16LE(4, 62);
  b.writeUInt32LE(1, 64); b.writeUInt32LE(7, 68); b.writeBigUInt64LE(BASE, 80); b.writeBigUInt64LE(0x2000n, 96); b.writeBigUInt64LE(0x2100n, 104); b.writeBigUInt64LE(0x1000n, 112);
  b.writeUInt32LE(2, 120); b.writeUInt32LE(6, 124); b.writeBigUInt64LE(0x700n, 128); b.writeBigUInt64LE(BASE + 0x700n, 136); b.writeBigUInt64LE(0xa0n, 152); b.writeBigUInt64LE(0xa0n, 160); b.writeBigUInt64LE(8n, 168);
  b[0x200] = 0xc3; b.fill(0xc3, 0x300, 0x320);
  const names = ['.text', '.rodata', '.bss', '.shstrtab', '.dynstr', '.dynsym', '.dynamic', '.rela.plt', '.gnu.version', '.gnu.version_r'];
  const nameIndexes: number[] = [];
  let position = 1;
  for (const name of names) { nameIndexes.push(position); position += b.write(`${name}\0`, 0xb00 + position); }
  const dynNames = '\0external\0exported\0libexample.so\0VERSION_1\0'; b.write(dynNames, 0x400);
  const section = (index: number, type: number, flags: bigint, offset: number, size: number, link = 0, info = 0, stride = 0n): void => {
    const p = SHOFF + index * 64;
    b.writeUInt32LE(nameIndexes[index - 1]!, p); b.writeUInt32LE(type, p + 4); b.writeBigUInt64LE(flags, p + 8);
    b.writeBigUInt64LE(flags & 2n ? BASE + BigInt(offset) : 0n, p + 16); b.writeBigUInt64LE(BigInt(offset), p + 24); b.writeBigUInt64LE(BigInt(size), p + 32);
    b.writeUInt32LE(link, p + 40); b.writeUInt32LE(info, p + 44); b.writeBigUInt64LE(1n, p + 48); b.writeBigUInt64LE(stride, p + 56);
  };
  section(1, 1, 6n, 0x200, 16); section(2, 1, 2n, 0x300, 32); section(3, 8, 3n, 0x2000, 0x100);
  section(4, 3, 0n, 0xb00, position); section(5, 3, 2n, 0x400, dynNames.length);
  section(6, 11, 2n, 0x500, 72, 5, 1, 24n); section(7, 6, 3n, 0x700, 0xa0, 5, 0, 16n); section(8, 4, 2n, 0x900, 24, 6, 0, 24n);
  b.writeUInt32LE(1, 0x518); b[0x51c] = 0x12;
  b.writeUInt32LE(10, 0x530); b[0x534] = 0x12; b.writeUInt16LE(1, 0x536); b.writeBigUInt64LE(BASE + 0x200n, 0x538); b.writeBigUInt64LE(1n, 0x540);
  const dynamic = [[1n, 19n], [5n, BASE + 0x400n], [10n, BigInt(dynNames.length)], [6n, BASE + 0x500n], [11n, 24n], [23n, BASE + 0x900n], [2n, 24n], [20n, 7n], [0n, 0n]];
  dynamic.forEach(([tag, value], index) => { b.writeBigUInt64LE(tag!, 0x700 + index * 16); b.writeBigUInt64LE(value!, 0x708 + index * 16); });
  b.writeBigUInt64LE(BASE + 0x380n, 0x900); b.writeBigUInt64LE((1n << 32n) | 7n, 0x908);
  if (versions) {
    section(9, 0x6fffffff, 2n, 0xa00, 6, 6, 0, 2n); section(10, 0x6ffffffe, 2n, 0xa20, 32, 5, 1);
    b.writeUInt16LE(2, 0xa02); b.writeUInt16LE(1, 0xa04);
    b.writeUInt16LE(1, 0xa20); b.writeUInt16LE(1, 0xa22); b.writeUInt32LE(19, 0xa24); b.writeUInt32LE(16, 0xa28);
    b.writeUInt16LE(2, 0xa36); b.writeUInt32LE(33, 0xa38);
  }
  return b;
}

for (const name of ['elf-x86_64-symbols', 'elf-x86_64-stripped', 'libcorpus-elf-x86_64-symbols.so', 'libcorpus-elf-x86_64-stripped.so']) {
  test(`compiler ELF ${name} preserves linked mappings and native evidence`, () => {
    const image = load(readFileSync(new URL(`../../../fixtures/bin/${name}`, import.meta.url)));
    assert.equal(image.target.format, 'elf'); assert.equal(image.target.abi, 'sysv-amd64');
    assert.equal(image.image_base, image.mappings.reduce((base, m) => m.va < base ? m.va : base, image.mappings[0]!.va));
    assert.ok(image.headers.some(h => h.kind === 'elf_header')); assert.ok(image.headers.some(h => h.kind === 'elf_dynamic' && h.name === 'DT_NEEDED'));
    const imported = image.imports.find(i => i.original_name === 'fixture_external');
    assert.ok(imported?.slot); assert.equal(imported.library, null); assert.equal(imported.callable_entry, null);
    assert.ok(image.relocations.some(r => r.encoding === 'R_X86_64_JUMP_SLOT' && r.address.value === imported.slot?.value));
    assert.ok(image.exports.some(e => e.original_name === 'fixture_arithmetic' && e.address));
    for (const section of image.sections) {
      if (section.virtual_range.start.space !== 'va' || !section.file_range?.size) continue;
      const translated = image.address_map.translate(section.virtual_range.start, 'file');
      assert.equal(translated.kind, 'mapped'); assert.equal(translated.address.value, section.file_range.start.value);
    }
    const proofs = new Set(image.evidence.map(e => e.id));
    for (const record of [...image.symbols, ...image.imports, ...image.exports, ...image.relocations, ...image.sections, ...image.headers, ...image.hints]) {
      assert.ok(record.evidence_ids.length); assert.ok(record.evidence_ids.every(id => proofs.has(id)));
    }
    if (name.includes('symbols')) assert.ok(image.symbols.some(s => s.original_name === 'fixture_arithmetic' && s.size && s.size > 0n));
  });
}

test('linked VA, RVA, file backing, BSS and unmapped space stay distinct for both linked types', () => {
  for (const type of [2, 3]) {
    const b = boundaryImage(); b.writeUInt16LE(type, 16); const image = load(b);
    assert.equal(image.image_base, BASE); assert.equal(image.entry_points[0]?.value, BASE + 0x200n);
    const address = (space: 'va' | 'rva' | 'file', value: bigint) => ({ image_id: image.id, space, value });
    assert.equal(image.address_map.translate(address('rva', 0x200n), 'file').address.value, 0x200n);
    assert.equal(image.address_map.translate(address('file', 0x200n), 'va').address.value, BASE + 0x200n);
    assert.equal(image.address_map.translate(address('va', BASE + 0x2000n), 'file').kind, 'zero_fill');
    assert.equal(image.address_map.translate(address('va', BASE + 0x2100n), 'file').kind, 'unmapped');
    assert.deepEqual(image.address_map.spans(address('va', BASE + 0x1ff8n), 16n).map(s => [s.kind, s.range.size, s.file_offset]), [['mapped', 8n, 0x1ff8n], ['zero_fill', 8n, null]]);
  }
});

test('DT_NEEDED alone never attributes an undefined symbol or invents a PLT callable entry', () => {
  for (const type of [1n, 6n, 7n]) {
    const b = boundaryImage(); b.writeBigUInt64LE((1n << 32n) | type, 0x908);
    const image = load(b), imported = image.imports[0]!;
    assert.equal(imported.original_name, 'external'); assert.equal(imported.library, null); assert.equal(imported.slot?.value, BASE + 0x380n); assert.equal(imported.callable_entry, null);
    assert.equal(image.relocations[0]?.symbol_id, image.symbols.find(s => s.original_name === 'external')?.id);
    assert.equal(image.relocations[0]?.target, null);
    assert.ok(image.headers.some(h => h.name === 'DT_NEEDED' && h.fields.some(f => f.kind === 'text' && f.value === 'libexample.so')));
  }
});

test('GNU version requirement is provider evidence, not DT_NEEDED position guessing', () => {
  const image = load(boundaryImage(true)), imported = image.imports[0]!;
  assert.equal(imported.library, 'libexample.so'); assert.equal(imported.callable_entry, null);
  const claims = image.evidence.filter(e => imported.evidence_ids.includes(e.id)).map(e => e.claim);
  assert.ok(claims.includes('ELF version requirement provider')); assert.ok(claims.includes('ELF imported symbol version index'));
  const broken = boundaryImage(true); broken.writeUInt16LE(3, 0xa02); failure(broken);
  const cycle = boundaryImage(true); cycle.writeUInt32LE(16, 0xa3c); failure(cycle);
});

test('unreferenced undefined dynamic symbols retain null slots; weak binding remains native', () => {
  const b = boundaryImage(); b[0x51c] = 0x22; b.writeBigUInt64LE(0n, 0x908);
  const image = load(b); assert.equal(image.imports[0]?.slot, null); assert.equal(image.imports[0]?.weak, true);
  assert.equal(image.imports[0]?.library, null); assert.equal(image.symbols.find(s => s.original_name === 'external')?.address, null);
});

test('RELA addends remain signed metadata and relative targets use linked VAs without a guessed bias', () => {
  const b = boundaryImage(); b.writeBigUInt64LE(8n, 0x908); b.writeBigInt64LE(BASE + 0x200n, 0x910);
  let image = load(b); assert.equal(image.relocations[0]?.addend, BASE + 0x200n); assert.equal(image.relocations[0]?.target?.value, BASE + 0x200n);
  b.writeBigInt64LE(-8n, 0x910); image = load(b); assert.equal(image.relocations[0]?.addend, -8n); assert.equal(image.relocations[0]?.target, null);
});

test('native tables and noninstruction sections remain data even inside executable mappings and with function symbols', () => {
  for (const [offset, section] of [[0x300n, 2], [0x500n, 6]] as const) {
    const b = boundaryImage(); b.writeBigUInt64LE(BASE + offset, 0x538); b.writeUInt16LE(section, 0x536);
    const image = load(b), decoder = new X86Decoder();
    try {
      const result = discoverFunctions({ image, decoder, revision: 0 }, createOperationContext());
      assert.ok(result.graphs.some(g => g.function.entry.value === BASE + 0x200n));
      const conflict = result.graphs.find(g => g.function.entry.value === BASE + offset);
      assert.ok(conflict); assert.equal(conflict.function.boundary, 'conflicting');
      assert.deepEqual(conflict.instructions, []); assert.equal(conflict.gaps[0]?.reason, 'data');
      assert.equal(image.symbols.find(s => s.original_name === 'exported')?.address?.value, BASE + offset);
      assert.ok(image.hints.some(h => h.kind === 'data' && h.range.start.space === 'file' && h.range.start.value === 0n && h.range.size === 64n));
      assert.ok(image.hints.some(h => h.kind === 'data' && h.range.start.space === 'file' && h.range.start.value === 0x500n));
    } finally { decoder.dispose(); }
  }
});

for (const [name, mutate] of [
  ['class', (b: Buffer) => { b[4] = 1; }], ['endian', (b: Buffer) => { b[5] = 2; }],
  ['machine', (b: Buffer) => { b.writeUInt16LE(183, 18); }], ['relocatable', (b: Buffer) => { b.writeUInt16LE(1, 16); }],
  ['OSABI', (b: Buffer) => { b[7] = 9; }], ['sectionless', (b: Buffer) => { b.writeBigUInt64LE(0n, 40); b.writeUInt16LE(0, 60); }],
  ['extended section count', (b: Buffer) => { b.writeUInt16LE(0, 60); }], ['extended symbol index', (b: Buffer) => { b.writeUInt16LE(0xffff, 0x536); }],
] as const) test(`unsupported ELF ${name} is explicit`, () => { const b = boundaryImage(); mutate(b); failure(b, 'unsupported_target'); });

for (const [name, mutate] of [
  ['short program entry', (b: Buffer) => b.writeUInt16LE(55, 54)], ['short section entry', (b: Buffer) => b.writeUInt16LE(63, 58)],
  ['section table outside file', (b: Buffer) => b.writeBigUInt64LE(0x1ff0n, 40)], ['program table overflow', (b: Buffer) => b.writeBigUInt64LE(0xfffffffffffffff0n, 32)],
  ['file backing exceeds memory', (b: Buffer) => b.writeBigUInt64LE(0x1000n, 104)], ['virtual range overflow', (b: Buffer) => b.writeBigUInt64LE(0xfffffffffffffff0n, 80)],
  ['bad load alignment', (b: Buffer) => b.writeBigUInt64LE(3n, 112)], ['load alignment incongruence', (b: Buffer) => b.writeBigUInt64LE(BASE + 1n, 80)],
  ['section mapping contradiction', (b: Buffer) => b.writeBigUInt64LE(0x201n, SHOFF + 64 + 24)], ['BSS backing contradiction', (b: Buffer) => b.writeBigUInt64LE(BASE + 0x1f00n, SHOFF + 3 * 64 + 16)],
  ['file section aliases', (b: Buffer) => { b.writeBigUInt64LE(0xb00n, SHOFF + 5 * 64 + 24); }],
  ['relative relocation names symbol', (b: Buffer) => b.writeBigUInt64LE((1n << 32n) | 8n, 0x908)],
  ['symbol relocation lacks symbol', (b: Buffer) => b.writeBigUInt64LE(7n, 0x908)],
  ['symbol outside section', (b: Buffer) => b.writeBigUInt64LE(BASE + 0x300n, 0x538)], ['symbol index outside table', (b: Buffer) => b.writeBigUInt64LE((99n << 32n) | 7n, 0x908)],
  ['relocation site outside memory', (b: Buffer) => b.writeBigUInt64LE(BASE + 0x2100n, 0x900)], ['dynamic string pointer contradiction', (b: Buffer) => b.writeBigUInt64LE(BASE + 0x2000n, 0x718)],
  ['unterminated dynamic records', (b: Buffer) => { b.writeBigUInt64LE(30n, 0x780); b.writeBigUInt64LE(31n, 0x790); }],
  ['dynamic/segment size contradiction', (b: Buffer) => b.writeBigUInt64LE(16n, 152)], ['string index outside table', (b: Buffer) => b.writeUInt32LE(0xffffffff, 0x518)],
  ['version string terminator outside table', (b: Buffer) => { b.fill(65, 0x400, 0x42b); }],
] as const) test(`malformed ELF ${name} fails rather than returning empty metadata`, () => { const b = boundaryImage(); mutate(b); failure(b); });

test('overlapping virtual or file PT_LOAD aliases cannot weaken the AddressMap contract', () => {
  for (const alias of ['va', 'file']) {
    const b = boundaryImage(); b.writeUInt16LE(3, 56); b.copy(b, 176, 64, 120);
    if (alias === 'file') b.writeBigUInt64LE(BASE + 0x4000n, 192);
    else { b.writeBigUInt64LE(0x1000n, 184); b.writeBigUInt64LE(BASE + 0x1000n, 192); b.writeBigUInt64LE(0x1000n, 208); b.writeBigUInt64LE(0x1000n, 216); }
    failure(b);
  }
});

test('unknown relocation encodings retain native bytes and explicitly decline width/target claims', () => {
  const b = boundaryImage(); b.writeBigUInt64LE((1n << 32n) | 0xdeadn, 0x908); const image = load(b);
  assert.equal(image.relocations.length, 0); assert.equal(image.imports[0]?.slot, null);
  assert.ok(image.diagnostics.some(d => d.code === 'unsupported_target' && d.message.includes('57005')));
  assert.ok(image.hints.some(h => h.kind === 'data' && h.range.start.space === 'file' && h.range.start.value === 0x900n));
});

test('cancellation and caller resource failures are preserved without partial success', () => {
  const controller = new AbortController(); controller.abort();
  assert.throws(() => load(boundaryImage(), createOperationContext({ signal: controller.signal })), (e: unknown) => e instanceof OperationError && e.code === 'cancelled');
  assert.throws(() => load(boundaryImage(), createOperationContext({ budget: { work: 10 } })), (e: unknown) => e instanceof OperationError && e.code === 'resource_limit');
  let checkpoints = 0;
  const context = createOperationContext(), duringLoad = new AbortController();
  assert.throws(() => load(boundaryImage(), { ...context, checkpoint(work) { context.checkpoint(work); if (++checkpoints === 100) duringLoad.abort(); }, signal: duringLoad.signal }), (e: unknown) => e instanceof OperationError && e.code === 'cancelled');
  assert.equal(checkpoints, 100);
});

test('truncation, invalid selection and record limits have typed diagnostics', () => {
  for (const length of [0, 4, 15, 16, 63, 100]) failure(boundaryImage().subarray(0, length));
  const b = boundaryImage(), sha256 = contentHash(b);
  assert.throws(() => new ELFLoader().load({ bytes: new ImmutableBytes(b), image_id: imageIdentity(sha256), sha256, slice_id: 'slice_wrong' }, createOperationContext()), (e: unknown) => e instanceof ELFLoadError && e.code === 'invalid_input');
  const large = Buffer.alloc(0x1000 + 65534 * 64); boundaryImage().copy(large); large.writeUInt16LE(65534, 60); large.writeUInt16LE(65534, 56); large.writeBigUInt64LE(64n, 32);
  failure(large, 'resource_limit');
});

test('bounded names cannot consume unbounded work or read a terminator beyond their string table', () => {
  const b = Buffer.alloc(0x5000); boundaryImage().copy(b);
  b.writeBigUInt64LE(0x3000n, SHOFF + 4 * 64 + 24); b.writeBigUInt64LE(4501n, SHOFF + 4 * 64 + 32);
  b.fill(65, 0x3001, 0x3000 + 4500);
  failure(b, 'resource_limit');
});

test('REL implicit addends can use actual backing or evidenced zero-fill without manufacturing file bytes', () => {
  for (const zero of [false, true]) {
    const b = boundaryImage();
    b.writeUInt32LE(9, SHOFF + 8 * 64 + 4); b.writeBigUInt64LE(16n, SHOFF + 8 * 64 + 32); b.writeBigUInt64LE(16n, SHOFF + 8 * 64 + 56);
    b.writeBigUInt64LE(16n, 0x768); b.writeBigUInt64LE(17n, 0x778);
    b.writeBigUInt64LE(BASE + (zero ? 0x2000n : 0x380n), 0x900); b.writeBigUInt64LE(8n, 0x908);
    if (!zero) b.writeBigInt64LE(BASE + 0x200n, 0x380);
    const image = load(b), relocation = image.relocations[0]!;
    assert.equal(relocation.addend, zero ? 0n : BASE + 0x200n);
    assert.equal(relocation.target?.value ?? null, zero ? null : BASE + 0x200n);
    assert.ok(relocation.evidence_ids.some(id => image.evidence.some(e => e.id === id && e.claim.includes('implicit relocation addend'))));
  }
});

test('dynamic pointers reject nonallocated section bytes that contradict translated backing', () => {
  for (const [section, source, size] of [[5, 0x400, 43], [6, 0x500, 72], [8, 0x900, 24]] as const) {
    const b = boundaryImage();
    b.copy(b, 0xc00, source, source + size);
    b.writeBigUInt64LE(0n, SHOFF + section * 64 + 8);
    b.writeBigUInt64LE(0xc00n, SHOFF + section * 64 + 24);
    if (section === 6) b.writeUInt32LE(10, 0xc18);
    failure(b);
  }
  const b = boundaryImage();
  b.writeUInt16LE(10, 60);
  b.copy(b, 0xc00, 0x400, 0x42b);
  const extra = SHOFF + 9 * 64;
  b.writeUInt32LE(3, extra + 4); b.writeBigUInt64LE(0xc00n, extra + 24); b.writeBigUInt64LE(43n, extra + 32);
  b.writeUInt32LE(9, SHOFF + 6 * 64 + 40);
  failure(b);
});

test('IFUNC relocations never publish the resolver as the resolved pointer target', () => {
  for (const type of [1n, 6n, 7n]) {
    const b = boundaryImage(); b[0x534] = 0x1a;
    b.writeBigUInt64LE((2n << 32n) | type, 0x908);
    const image = load(b);
    assert.equal(image.symbols.find(s => s.original_name === 'exported')?.address?.value, BASE + 0x200n);
    assert.equal(image.exports.find(e => e.original_name === 'exported')?.address, null);
    assert.equal(image.relocations[0]?.target, null);
    assert.ok(image.diagnostics.some(d => d.message.includes('IFUNC')));
  }
});

test('absolute text relocations preserve instruction operands instead of creating data barriers', () => {
  const b = boundaryImage();
  b.set([0x48, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0xc3], 0x200);
  b.writeBigUInt64LE(11n, 0x540);
  b.writeBigUInt64LE(BASE + 0x202n, 0x900); b.writeBigUInt64LE((1n << 32n) | 1n, 0x908);
  b.writeBigUInt64LE(7n, 0x750); b.writeBigUInt64LE(8n, 0x760); b.writeBigUInt64LE(9n, 0x770); b.writeBigUInt64LE(24n, 0x778);
  const image = load(b);
  assert.equal(image.relocations[0]?.address.value, BASE + 0x202n);
  assert.equal(image.imports.find(i => i.original_name === 'external')?.slot, null);
  assert.ok(image.imports.find(i => i.original_name === 'external')?.evidence_ids.some(id => image.relocations[0]!.evidence_ids.includes(id)));
  assert.ok(!image.hints.some(h => h.kind === 'data' && h.range.start.space === 'va' && h.range.start.value < BASE + 0x20an && h.range.start.value + h.range.size > BASE + 0x202n));
  const decoder = new X86Decoder();
  try {
    const result = discoverFunctions({ image, decoder, revision: 0 }, createOperationContext());
    const graph = result.graphs.find(g => g.function.entry.value === BASE + 0x200n);
    assert.ok(graph); assert.equal(graph.instructions.length, 2);
    assert.equal(graph.instructions[0]?.size, 10);
  } finally { decoder.dispose(); }
});
