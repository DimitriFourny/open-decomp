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
import { recoverImportBindings } from '../../src/analysis/strings/source-data.js';

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

const targets = [
  { loader: () => new MachOLoader(), file: 'macho-arm64-symbols', symbol: '_puts', source: 'puts' },
  {
    loader: () => new ELFLoader(),
    file: 'elf-x86_64-symbols',
    symbol: 'fixture_external',
    source: 'fixture_external',
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
    const image = load(target.loader(), target.file);
    const slots = image.imports.filter(
      (item) => item.original_name === target.symbol && item.slot && !item.delayed,
    );
    assert.ok(slots.length > 0);
    const candidates = new Map(slots.map((item) => [key(item.slot!), item.slot!]));
    const bound = recoverImportBindings(image, candidates, none, createOperationContext());
    assert.ok(bound.size > 0);
    for (const [slot, item] of bound) {
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
    assert.ok([...renamed.values()].every((item) => item.source_name === 'my_name'));
    const unresolved = recoverImportBindings(
      image,
      candidates,
      () => ({ asserted: [], annotated: true }),
      createOperationContext(),
    );
    assert.equal(unresolved.size, 0);
  });

test('stub entries and lazily bound slots are not data bindings', () => {
  const image = load(new MachOLoader(), 'macho-arm64-symbols');
  const stubs = image.imports.filter((item) => item.callable_entry);
  assert.ok(stubs.length > 0);
  const candidates = new Map(
    stubs.map((item) => [key(item.callable_entry!), item.callable_entry!]),
  );
  assert.equal(recoverImportBindings(image, candidates, none, createOperationContext()).size, 0);
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
