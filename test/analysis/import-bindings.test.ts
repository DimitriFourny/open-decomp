import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  contentHash,
  createOperationContext,
  imageIdentity,
  ImmutableBytes,
  type Address,
  type Loader,
  type LoadedImage,
} from '../../src/core/index.js';
import { MachOLoader } from '../../src/loaders/macho/index.js';
import { ELFLoader } from '../../src/loaders/elf/index.js';
import { PELoader } from '../../src/loaders/pe/index.js';
import { Arm64Decoder } from '../../src/decoders/arm64/index.js';
import { X86Decoder } from '../../src/decoders/x86_64/index.js';
import { discoverFunctions } from '../../src/analysis/discovery/index.js';
import { classifyImportStubs } from '../../src/analysis/discovery/stubs.js';
import { buildReferenceIndex } from '../../src/analysis/references/index.js';
import { buildStringIndex } from '../../src/analysis/strings/index.js';
import {
  recoverDataAddress,
  recoverImportBindings,
} from '../../src/analysis/strings/source-data.js';

function load(loader: Loader, name: string): LoadedImage {
  const input = readFileSync(new URL(`../../fixtures/bin/${name}`, import.meta.url));
  const sha256 = contentHash(input),
    image_id = imageIdentity(sha256),
    bytes = new ImmutableBytes(input);
  const selected = loader
    .inspect(bytes, image_id, createOperationContext())
    .slices.find((slice) => slice.supported);
  assert.ok(selected);
  return loader.load({ image_id, sha256, bytes, slice_id: selected.id }, createOperationContext());
}
const key = (address: Address): string => `${address.image_id}:${address.space}:${address.value}`;
const none = () => ({ asserted: [], annotated: false });
/** The ELF fixture binds `fixture_external` lazily in a writable `.got.plt`; a
 * `PT_GNU_RELRO` header over its slot makes the slot read-only after relocation. */
function withRelro(image: LoadedImage, slot: Address): LoadedImage {
  const template = image.headers.find((header) => header.kind === 'elf_program_header');
  assert.ok(template);
  return {
    ...image,
    headers: [
      ...image.headers,
      {
        ...template,
        name: 'synthetic PT_GNU_RELRO',
        fields: [
          { kind: 'integer', name: 'p_type', value: 0x6474e552n },
          { kind: 'integer', name: 'p_vaddr', value: slot.value },
          { kind: 'integer', name: 'p_memsz', value: 8n },
        ],
      },
    ],
  };
}

const targets = [
  { loader: () => new MachOLoader(), file: 'macho-arm64-symbols', symbol: '_puts', source: 'puts' },
  {
    loader: () => new ELFLoader(),
    file: 'elf-x86_64-symbols',
    symbol: 'fixture_external',
    source: 'fixture_external',
    relro: true,
  },
  {
    loader: () => new PELoader(),
    file: 'pe-x86_64-symbols.exe',
    symbol: 'ExitProcess',
    source: 'ExitProcess',
  },
] as const;

for (const target of targets)
  test(`${target.file}: a loader binding slot names its imported symbol in C spelling`, () => {
    let image = load(target.loader(), target.file);
    const slots = image.imports.filter(
      (item) => item.original_name === target.symbol && item.slot && !item.delayed,
    );
    assert.ok(slots.length > 0);
    if ('relro' in target) image = withRelro(image, slots[0]!.slot!);
    const candidates = new Map(slots.map((item) => [key(item.slot!), item.slot!]));
    const bound = recoverImportBindings(image, candidates, none, createOperationContext());
    assert.ok(bound.bindings.size > 0);
    assert.equal(bound.initial.size, 0);
    for (const [slot, item] of bound.bindings) {
      assert.ok(candidates.has(slot));
      assert.equal(item.name, target.symbol);
      assert.equal(item.source_name, target.source);
      assert.ok(item.evidence_ids.length > 0);
    }
    // An asserted rename is verbatim; any other annotation leaves the slot unbound.
    const renamed = recoverImportBindings(
      image,
      candidates,
      () => ({ asserted: ['my_name'], annotated: true }),
      createOperationContext(),
    );
    assert.ok([...renamed.bindings.values()].every((item) => item.source_name === 'my_name'));
    const unresolved = recoverImportBindings(
      image,
      candidates,
      () => ({ asserted: [], annotated: true }),
      createOperationContext(),
    );
    assert.equal(unresolved.bindings.size, 0);
  });

test('a bind in writable program data is plain storage; a __got bind is an import slot', () => {
  const image = load(new MachOLoader(), 'macho-arm64-symbols');
  const puts = image.imports.find((item) => item.original_name === '_puts' && item.slot);
  assert.ok(puts?.slot);
  const section = (name: string) => {
    const found = image.sections.find((item) => item.kind === 'section' && item.name === name);
    assert.ok(found);
    return found;
  };
  const got = section('__got'),
    data = section('__data');
  assert.ok(
    puts.slot.value >= got.virtual_range.start.value &&
      puts.slot.value < got.virtual_range.start.value + got.virtual_range.size,
  );
  assert.ok(data.permissions.includes('write'));
  const inGot = recoverImportBindings(
    image,
    new Map([[key(puts.slot), puts.slot]]),
    none,
    createOperationContext(),
  );
  assert.equal(inGot.bindings.get(key(puts.slot))?.source_name, 'puts');
  // The same bind record placed in `__DATA,__data` (as SQLite's `aSyscall` slots
  // are): program code may rewrite it, so it only states its load-time value.
  const slot = data.virtual_range.start;
  const moved: LoadedImage = {
    ...image,
    imports: image.imports.map((item) => (item === puts ? { ...item, slot } : item)),
  };
  const inData = recoverImportBindings(
    moved,
    new Map([[key(slot), slot]]),
    none,
    createOperationContext(),
  );
  assert.equal(inData.bindings.size, 0);
  assert.equal(inData.initial.get(key(slot)), 'puts');
});

test('an ELF lazy slot in writable .got.plt is plain storage until RELRO covers it', () => {
  const image = load(new ELFLoader(), 'elf-x86_64-symbols');
  const item = image.imports.find((entry) => entry.original_name === 'fixture_external');
  assert.ok(item?.slot);
  const candidates = new Map([[key(item.slot), item.slot]]);
  const writable = recoverImportBindings(image, candidates, none, createOperationContext());
  assert.equal(writable.bindings.size, 0);
  assert.equal(writable.initial.get(key(item.slot)), 'fixture_external');
  const relro = recoverImportBindings(
    withRelro(image, item.slot),
    candidates,
    none,
    createOperationContext(),
  );
  assert.equal(relro.bindings.get(key(item.slot))?.name, 'fixture_external');
});

test('stub entries and lazily bound slots are not data bindings', () => {
  const image = load(new MachOLoader(), 'macho-arm64-symbols');
  const stubs = image.imports.filter((item) => item.callable_entry);
  assert.ok(stubs.length > 0);
  const candidates = new Map(
    stubs.map((item) => [key(item.callable_entry!), item.callable_entry!]),
  );
  const bound = recoverImportBindings(image, candidates, none, createOperationContext());
  assert.equal(bound.bindings.size + bound.initial.size, 0);
});

test('an interior address of a size-less object symbol is named relative to it, extent unknown', () => {
  const image = load(new MachOLoader(), 'macho-arm64-symbols');
  const symbol = image.symbols.find((item) => item.original_name === '_fixture_zero_fill');
  assert.ok(symbol?.address && symbol.kind === 'object' && symbol.size === null);
  const interior = { ...symbol.address, value: symbol.address.value + 0x10n };
  const recovered = recoverDataAddress(image, interior, createOperationContext());
  assert.equal(recovered?.name, undefined);
  assert.deepEqual(recovered?.symbol_relative, {
    symbol_id: symbol.id,
    name: '_fixture_zero_fill',
    offset: 0x10n,
    evidence_ids: symbol.evidence_ids,
  });
  assert.equal(recovered?.object?.address.value, interior.value);
  assert.equal(recovered?.object?.byte_length, null);
  // The symbol's own address is the symbol; another symbol start in between
  // ends the relative naming.
  const base = recoverDataAddress(image, symbol.address, createOperationContext());
  assert.equal(base?.name, '_fixture_zero_fill');
  assert.equal(base?.symbol_relative, undefined);
  const shadowed = recoverDataAddress(image, interior, createOperationContext(), [
    ...image.symbols,
    {
      ...symbol,
      id: 'function-between',
      kind: 'function',
      address: { ...interior, value: interior.value - 8n },
    },
  ]);
  assert.equal(shadowed?.symbol_relative, undefined);
});

for (const target of [
  { loader: () => new MachOLoader(), file: 'macho-arm64-symbols', name: '_puts', arm: true },
  {
    loader: () => new ELFLoader(),
    file: 'elf-x86_64-symbols',
    name: 'fixture_external',
    arm: false,
  },
])
  test(`${target.file}: a body that only forwards through an import slot is a complete named stub`, () => {
    const image = load(target.loader(), target.file);
    const context = createOperationContext();
    const decoder = target.arm ? new Arm64Decoder() : new X86Decoder({ formatting: false });
    try {
      const discovery = discoverFunctions({ image, decoder, revision: 0 }, context);
      const strings = buildStringIndex({ image, revision: 0 }, context);
      const references = buildReferenceIndex({ image, discovery, strings, revision: 0 }, context);
      const stubs = classifyImportStubs(image, discovery.graphs, references.references, context);
      const found = [...stubs].map(([id, stub]) => ({
        stub,
        graph: discovery.graphs.find((graph) => graph.function.id === id)!,
      }));
      const mine = found.filter(({ stub }) => stub.import.original_name === target.name);
      assert.equal(mine.length, 1);
      const { stub, graph } = mine[0]!;
      assert.ok(graph.instructions.length <= 4);
      assert.ok(stub.evidence_ids.length > 0);
      // Real code is never mistaken for a stub.
      const ordinary = discovery.graphs.find(
        (item) => item.function.original_name?.startsWith('fixture_arithmetic') === true,
      );
      if (ordinary) assert.ok(!stubs.has(ordinary.function.id));
      // A callable entry, when the loader has one, is the stub's exact entry.
      if (stub.import.callable_entry)
        assert.equal(stub.import.callable_entry.value, graph.function.entry.value);
    } finally {
      decoder.dispose();
    }
  });
